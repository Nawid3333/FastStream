// SPLICER:NO_YOUTUBE:REMOVE_FILE
if (window.parent !== window) {
  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent) {
      return;
    }

    if (!event.data || event.data.type !== 'sandboxEvaluate') {
      return;
    }

    const {body, argNames = [], argValues = []} = event.data;

    const reply = (message) => {
      event.source.postMessage(message, event.origin);
    };

    try {
      const fn = new Function(...argNames, body);
      const result = await fn(...argValues);
      reply({type: 'sandboxResult', result});
    } catch (error) {
      try {
        reply({type: 'sandboxError', error});
      } catch (postError) {
        reply({type: 'sandboxError', error: {message: String(error && error.message || error)}});
      }
    }
  });
}
