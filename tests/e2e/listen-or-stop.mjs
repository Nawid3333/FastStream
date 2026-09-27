// Starts a suite's own test server on its fixed port, or stops the whole run.
//
// wdio only logs an error thrown in onPrepare, and then runs every spec anyway. When the
// port was taken - by another test run on this machine, or verify:linux in WSL, which
// shares these ports - the specs were answered by that run's server and tested its build:
// on 2026-09-27 a keybind spec saw a seek to -3 s land at -3, from a build without the
// fix it was checking, and later runs lost the server halfway. With the port held by
// another process a spec even passed, and wdio exited 0. So the run stops here instead.

/**
 * Listens on 127.0.0.1:port, or ends the process with the reason.
 * @param {import('node:http').Server} server - The suite's server.
 * @param {number} port - Its fixed port.
 * @param {function(): void} resolve - Called once it listens.
 */
export function listenOrStop(server, port, resolve) {
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ?
      `\nPort ${port} is already in use, most likely by another test run on this machine ` +
        '(another checkout, or verify:linux in WSL). Its server would answer these specs, ' +
        'so the run stops here.\n' :
      `\nThe test server on port ${port} failed: ${error.message}\n`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', resolve);
}
