/*
 * scilab-web.js -- run Scilab (WebAssembly, with its Java GUI) in a web page.
 *
 *   <div id="x11-wasm-root" style="position:absolute;inset:0"></div>
 *   <script src="scilab-web.js"></script>
 *   <script>
 *     Scilab.run({ root: document.getElementById('x11-wasm-root') });
 *   </script>
 *
 * The files (scilab.js, scilab.wasm, scilab-share.json/.data.gz,
 * openjdk21-jre.json/.data.gz) are loaded from the directory of this script,
 * or from data-base / options.base.
 *
 * Scilab and the JVM run in Web Workers sharing the module's memory, so the
 * page must be cross-origin isolated (Cross-Origin-Opener-Policy: same-origin
 * and Cross-Origin-Embedder-Policy: require-corp).  When the server does not
 * send these headers, this script loads coi-serviceworker.js from its own
 * directory, which adds them and reloads the page once (pages in that
 * directory or below it, over https or on localhost).  Disable with
 * data-coi="off" on the script tag.
 *
 * Copyright (c) 2026 emscripten-forge contributors.  GPL-2.0-only, like Scilab.
 */
(function (global) {
  'use strict';

  var thisScript = document.currentScript;
  var defaultBase = (thisScript && (thisScript.getAttribute('data-base') ||
                     thisScript.src.replace(/[^\/]*$/, ''))) || './';

  function withSlash(base) {
    return base && base.slice(-1) !== '/' ? base + '/' : base;
  }

  // SharedArrayBuffer needs a cross-origin isolated page
  var coiRequested = false;
  function requestIsolation(base) {
    if (global.crossOriginIsolated || coiRequested) return;
    coiRequested = true;
    var s = document.createElement('script');
    s.src = withSlash(base) + 'coi-serviceworker.js';
    document.head.appendChild(s);
    var sw = global.navigator && navigator.serviceWorker;
    if (!sw || !global.isSecureContext) return;
    var KEY = 'scilab-coi-retry';
    try {
      if (sessionStorage.getItem(KEY)) { sessionStorage.removeItem(KEY); return; }
    } catch (e) { return; }
    sw.ready.then(function () {
      setTimeout(function () {
        if (global.crossOriginIsolated) return;
        try { sessionStorage.setItem(KEY, '1'); } catch (e) { return; }
        location.reload();
      }, 100);
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (global.createScilabModule) return resolve();
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('cannot load ' + src)); };
      document.head.appendChild(s);
    });
  }

  var running = null;   // one Scilab per page

  /**
   * Start Scilab.  options:
   *   root          element the windows are drawn in (default #x11-wasm-root);
   *                 its size is the size of the screen
   *   args          Scilab command-line arguments (default: none, the
   *                 desktop); e.g. ['-e', 'xcos()'] or ['-f', '/path/x.sce']
   *   base          where the files are (default: this script's directory)
   *   env           environment variables, e.g. { LANG: 'fr_FR.UTF-8' }
   *   javaOptions   extra JVM options (SCI_WASM_JAVA_OPTIONS), e.g. '-Xmx768m'
   *   files         { vmPath: url }: files to put in the file system first
   *   windowManager true (default): title bars to move, resize and close the
   *                 windows; false: windows stay where Java puts them
   *   documentTitle false: keep the page title (default: the active window's)
   *   persistHome   false: do not keep the home directory (SCIHOME) between
   *                 visits (IndexedDB)
   *   onStdout, onStderr (lines), onProgress(loaded, total) while the files
   *   download, onExit(status)
   * Returns a promise for the Emscripten module once main() has started.
   */
  function run(options) {
    options = options || {};
    if (running) return Promise.reject(new Error('Scilab is already running in this page'));
    var base = withSlash(options.base || defaultBase);
    if (!global.crossOriginIsolated) {
      return Promise.reject(new Error('Scilab needs a cross-origin isolated page ' +
        '(COOP/COEP headers, or coi-serviceworker.js next to scilab-web.js and the page ' +
        'in that directory or below it)'));
    }
    var files = options.files || {};
    var env = {};
    var k;
    for (k in (options.env || {})) env[k] = options.env[k];
    if (options.javaOptions) env['SCI_WASM_JAVA_OPTIONS'] = options.javaOptions;
    var moduleArg;
    running = loadScript(base + 'scilab.js').then(function () {
      return global.createScilabModule(moduleArg = {
        locateFile: function (p) { return base + p; },
        x11WasmRoot: options.root || document.getElementById('x11-wasm-root'),
        x11WasmDocumentTitle: options.documentTitle !== false,
        x11WasmWindowManager: options.windowManager !== false,
        scilabEnv: env,
        persistHome: options.persistHome !== false,
        print: options.onStdout || function (s) { console.log(s); },
        printErr: options.onStderr || function (s) { console.warn(s); },
        onPackProgress: options.onProgress,
        onExit: function (status) {
          if (moduleArg.saveHome) moduleArg.saveHome();
          if (options.onExit) options.onExit(status);
        },
        preRun: [function (M) {
          var names = Object.keys(files);
          if (!names.length) return;
          M.addRunDependency('scilab-user-files');
          Promise.all(names.map(function (vmPath) {
            return fetch(files[vmPath]).then(function (r) {
              if (!r.ok) throw new Error(files[vmPath] + ': HTTP ' + r.status);
              return r.arrayBuffer();
            }).then(function (buf) {
              M.FS.mkdirTree(vmPath.replace(/\/[^\/]*$/, '') || '/');
              M.FS.writeFile(vmPath, new Uint8Array(buf));
            });
          })).then(function () {
            M.removeRunDependency('scilab-user-files');
          }, function (e) {
            console.error('Scilab: ' + e);
          });
        }],
      });
    }).then(function (M) {
      M.callMain(options.args || []);
      return M;
    });
    return running;
  }

  global.Scilab = { run: run };

  if (!thisScript || thisScript.getAttribute('data-coi') !== 'off') requestIsolation(defaultBase);
})(typeof globalThis !== 'undefined' ? globalThis : window);
