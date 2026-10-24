// Opens one port to the probe host at every start of this event page, as FastStream's MPV
// watch does, and does what the host's first message asks: nothing more ("silent"), or a
// message on the port every 1.5 s ("out"). The host logs when the port closes.
const port = browser.runtime.connectNative('faststream.idle.probe');
port.onMessage.addListener((message) => {
  if (message && message.mode === 'out') {
    setInterval(() => port.postMessage({type: 'ping', at: Date.now()}), 1500);
  }
});
port.onDisconnect.addListener(() => {});
port.postMessage({type: 'hello', at: Date.now()});
