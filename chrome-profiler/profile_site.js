const fs = require('fs');
const puppeteer = require('puppeteer');
const spawn = require('child_process').spawn;
const path = require('path');
const { URL } = require('url');
const config = require(path.resolve(__dirname, 'config.json'));
const simpleGit =  require('simple-git/promise')();
const os = require('os');
const pusage = require('pidusage');
const sum = (a,b)=> a + b;
const timeout = ms => new Promise(res => setTimeout(res, ms));
const getDateTime =_ => new Date().toISOString().replace(/[-:\.]/g, '_');
const formatNumber = num=>Number(num.toLocaleString('en-US', {maximumFractionDigits: 2}));
const formatBytes = bytes=>formatNumber(bytes/Math.pow(1024,2));
let child;
/**
 * function to spawn a new linux process
 * @param  {string} dir working directory for the process
 * @param  {string} cmd command to start the new process
 * @return {object}     spawned Process
 */
function spawnProcess(dir, cmd) {
  const cmdParts = cmd.split(/\s+/);

  return spawn(cmdParts[0], cmdParts.slice(1), {cwd: dir});
}
if(process.env.SKIP_START_APP){
  hookProfiler();//hook the profiler to a headless chrome
} else {
  child = spawnProcess('.', 'npm start');
  child.stdout.on('data', async function (data) {
    console.log(data.toString('utf-8'));
    //check if the angular app has been served.
    if (data && data.indexOf('[at-loader] Ok') >= 0) {
      await timeout(config.waitTimeout);// sleep to ensure everything is prepared
      hookProfiler();//hook the profiler to a headless chrome
    }
  });

  // log any errors in child process
  child.stderr.on('data', function (data) {
    console.log("error", data.toString('utf-8'));
  });
}


async function hookProfiler() {
  let browser;
  try {
    //launch chrome headless
    if(config.puppeteerOptions.executablePath && !fs.existsSync(config.puppeteerOptions.executablePath)){
      let found = false;
      config.chromePaths.forEach(p=>{
        if(fs.existsSync(p)){
          config.puppeteerOptions.executablePath = p;
          found = true;
        }
      });
      if(!found){
        throw new Error('There is not valid Chrome path found in your configuration file!')
      }
    }
    console.log(`Chrome path is ${config.puppeteerOptions.executablePath}`);
    browser = await puppeteer.launch(config.puppeteerOptions);
    const chromeProcess = await browser.process();
    const pid = chromeProcess.pid;
    console.log(`Chrome process pid is ${pid}`);
    const routes = config.routes;
    const profiles = {'total-routes': routes.length, routes:[]};
    let stats = [];
    for(let i=0; i< routes.length; i++) {
      try{
        let cpuCheck = setInterval(()=>{
          pusage.stat(pid, {advanced: true}, function (err, stat) {
            if(err){
              console.log(err);
            } else {
              console.log('pusage', stat);
              stats.push(stat);
            }
          });
        }, config.usageInterval);
        const page = await browser.newPage();
        const result = await pageProfiler(routes[i], page);

        clearInterval(cpuCheck);
        pusage.unmonitor(process.pid);
        result['total-cpu-utilization-percentage'] = formatNumber(stats.map(x=>x.cpu).reduce(sum)/stats.length);
        stats = [];
        console.log(result);
        profiles.routes.push(result);
        await page.close();
        await timeout(config.testBetweenTimeout);
      }catch(err){
        // catch error to avoid error in one page
        console.error(err);
      }
    }
    const profilesName = path.join(config.profileFolder, `profiles-${getDateTime()}.json`);
    fs.writeFileSync(profilesName, JSON.stringify(profiles));
    //add profile result to git if is not skip and current directory is git repo
    if(!process.env.SKIP_ADD_GIT && await simpleGit.checkIsRepo()){
      await simpleGit.add(profilesName);
    }
  } catch (err) {
    console.error(err);
  } finally {
     if (browser) {
       await browser.close();
     }
     if(child){
       // will exit after destroy stdin of child and kill child
       child.stdin.destroy();
       child.kill();
     }
     process.exit();
  }
}

/**
 * Profile page with url/selector
 * @param route contains the page url and selector
 * @param page the chrome page
 * @returns profile result with all information
 */
async function pageProfiler(route, page) {
  const url = route.url;
  console.log(`Go to page with url ${url}`);
  const client = page._client;
  const networkRequests = [];//log network requests
  page.on('error', err => {
    console.log(err);
    throw err;
  });
  page.on('pageerror', perr => {
    console.log(perr);
    throw perr;
  });
  let totalBrowserObjects = 0;
  const scripts = [];
  page.on('request', request => {
    if(request._resourceType === 'script'){
      scripts.push(new Date().getTime());
    }
    // just count the number of HTTP GET requests for each route as the number of browser objects
    if(request._url && request._url.toLowerCase().startsWith("http")
    && request._method && request._method === 'GET'){
      totalBrowserObjects++;
    }
  });
  page.on('requestfinished', request => {
    networkRequests.push({
      'requestId': request._requestId,
      'documentURL': request._url,
      'request': {
        'method': request._method,
        'headers': request._headers
      },
      'response': {
        'url': request._response._url,
        'status': request._response._status,
        'headers': request._response._headers
      },
      'type': request._resourceType,
      'frameId': request._frame._id
    });

  });
  // need to listen console in page and Log.entryAdded in client to get all logs
  const logs = [];
  page.on('console', msg => {
    logs.push({
      type: msg._type,
      text: msg._text
    });
  });
  client.on('Log.entryAdded', logEntry => {
    logs.push(logEntry.entry);
  });

  // start events

  await client.send('Page.enable');
  await client.send('Log.enable');
  await client.send('Log.startViolationsReport', {config:[]});
  await client.send('Network.enable');
  await client.send('Network.clearBrowserCache');// make sure no cache/cookies
  await client.send('Network.clearBrowserCookies');
  await client.send('Performance.enable');// actually enable by page by default
  // evaluateOnNewDocument is invoked after the document was created but before any of its scripts were run
  await page.evaluateOnNewDocument(() => {
    // must not exist such field in window
    window.sync_async_xhr_total = {
      async:0,
      sync:0
    };
    XMLHttpRequest.prototype.open = (function(open){
      return function(method, url, async, user, password) {
        // https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/open
        // async An optional Boolean parameter, defaulting to true
        if(async === false){
          window.sync_async_xhr_total.sync++;
        } else {
          window.sync_async_xhr_total.async++;
        }
        open.apply(this, arguments);
      };
    })(XMLHttpRequest.prototype.open);
  });
  await page.tracing.start(config.tracingOptions);
  // go to page with url and wait for selector
  await page.goto(url, {timeout: config.pageTimeout});
  await page.waitForSelector(route.selector, {timeout: config.pageTimeout});
  // stop events
  await page.tracing.stop();
  const pageMetrics = await page.metrics();
  console.log('page metrics:', pageMetrics);
  try{
    await client.send('Performance.disable');
    await client.send('Network.disable');
    await client.send('Page.stopLoading');// Force the page stop all navigations and pending resource fetches
    await client.send('Log.stopViolationsReport');
    await client.send('Log.disable');
    await client.send('Page.disable');
  }catch(e){
    //catch error to avoid page crash error
    console.error(e);
  }


  const datetime  = getDateTime();

  // timeline or trace file
  const traceName = path.join(config.profileFolder, `trace-${datetime}.json`);
  if(fs.existsSync(config.tracingOptions.path)){
    fs.renameSync(config.tracingOptions.path, traceName);
  }

  // save the network data
  const networkName = path.join(config.profileFolder, `networks-${datetime}.json`);
  fs.writeFileSync(networkName,JSON.stringify(networkRequests));

  // save the logs
  const logsName = path.join(config.profileFolder, `logs-${datetime}.json`);
  fs.writeFileSync(logsName, JSON.stringify(logs));


  const totalWatchers = await page.evaluate(_ => {
    window.angular =  window.angular || {}; // avoid ReferenceError
    if(!angular|| !angular.element){
      // can only calculate watchers of Angular1 application
      return 0;
    } else {
      function getWatchers(root) {
        root = angular.element(root || document.documentElement);

        function getElemWatchers(element) {
          var isolateWatchers = getWatchersFromScope(element.data().$isolateScope);
          var scopeWatchers = getWatchersFromScope(element.data().$scope);
          var watchers = scopeWatchers.concat(isolateWatchers);
          angular.forEach(element.children(), function (childElement) {
            watchers = watchers.concat(getElemWatchers(angular.element(childElement)));
          });
          return watchers;
        }

        function getWatchersFromScope(scope) {
          if (scope) {
            return scope.$$watchers || [];
          } else {
            return [];
          }
        }

        return getElemWatchers(root);
      }
      return getWatchers().length;
    }
  });


  const sourceUrl = new URL(url);
  const sourceOrigin = sourceUrl.origin;
  const storageUsage = await client.send('Storage.getUsageAndQuota', {origin: sourceOrigin});
  console.log('storage usage', storageUsage);
  const indexDBStorage = storageUsage.usageBreakdown.find(s=>s.storageType === 'indexeddb');


  const  totalGlobalVariables  = await page.evaluate(_ =>Object.keys(window).length);
  const  totalCache  = await page.evaluate(_ =>{
    // https://stackoverflow.com/questions/4391575/how-to-find-the-size-of-localstorage
    // Each length is multiplied by 2 because the char in javascript stores as UTF-16 (occupies 2 bytes)
    // Storage will always return nothing or zero so have to calculate in this way
    return Object.keys(window.localStorage)
        .reduce((previous, key)=>
          previous + (key.length + window.localStorage[key].length) * 2, 0)
      + Object.keys(window.sessionStorage)
        .reduce((previous, key)=>previous + (key.length + window.sessionStorage[key].length) * 2, 0)
  });

  //add profile result to git if is not skip and current directory is git repo
  if(!process.env.SKIP_ADD_GIT && await simpleGit.checkIsRepo()){
    await simpleGit.add([traceName, networkName, logsName]);
  }
  const totalXHR = await page.evaluate(_ =>window.window.sync_async_xhr_total);
  const events = fs.readFileSync(traceName, 'utf8')
  const tracing = JSON.parse(events);
  const requestIds = tracing.traceEvents.filter(
    x =>
      x.cat === 'devtools.timeline' && x.name==='ResourceSendRequest'
      && x.args && x.args.data && x.args.data.url && !x.args.data.url.startsWith("data:")
      && x.args.data.requestId
  ).map(x=>x.args.data.requestId);
  const finishedResources = tracing.traceEvents.filter(
    x =>
      x.cat === 'devtools.timeline' && x.name==='ResourceFinish'
      && x.args && x.args.data
      && x.args.data.requestId  && requestIds.indexOf( x.args.data.requestId)!==-1
      && !isNaN(x.args.data.encodedDataLength)
  ).map(x=>x.args.data.encodedDataLength);

  const loadEventEnd = await page.evaluate(_ =>window.performance.timing.loadEventEnd);
  console.log('performance.timing.loadEventEnd', loadEventEnd);
  // lazy load mean script request start time >load end time
  const blockingScriptsTotal = scripts.filter(x=>x>loadEventEnd).length;
  console.log(`total scripts is ${scripts.length} and lazy load scripts total is ${blockingScriptsTotal}`);
  return {
    url: url,
    'total-watchers':totalWatchers,
    'total-cache-size-mb':formatBytes(totalCache),
    'total-indexeddb-size-mb': indexDBStorage ? formatBytes(indexDBStorage.usage): 0,
    'total-global-variables': totalGlobalVariables,
    'total-console-logs' : logs.length,
    'total-browser-objects': totalBrowserObjects,
    'blocking-scripts': blockingScriptsTotal,
    'total-sync-xhr': totalXHR.sync,
    'total-async-xhr': totalXHR.async,
    'total-memory-utilization-mb':formatBytes(pageMetrics.JSHeapTotalSize),
    'total-page-weight-mb': formatBytes(finishedResources.reduce(sum))
  }
}