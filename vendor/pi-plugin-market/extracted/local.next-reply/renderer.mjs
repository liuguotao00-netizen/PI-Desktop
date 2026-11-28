import React from 'react';

let dispose;

export function onLoad(pi) {
  const messages = new Map();
  let updateTimer;

  function Capture(props) {
    React.useEffect(() => {
      const { message, sessionId } = props;
      messages.set(sessionId + ':' + message.id, { ...message, sessionId });
      if (messages.size > 200) messages.delete(messages.keys().next().value);
      clearTimeout(updateTimer);
      updateTimer = setTimeout(() => {
        const rows = [...messages.values()]
          .filter(m => m.sessionId === sessionId)
          .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        const modelButton = [...document.querySelectorAll('button[aria-label]')].find(b =>
          /^(模型:|Model:)/.test(b.getAttribute('aria-label') || '')
        );
        const label = (modelButton?.getAttribute('aria-label') || '')
          .replace(/^(模型:|Model:)\s*/, '')
          .split(/\. (?:推理|Thinking|Reasoning)/)[0];
        pi.dispatch('plugin.call', {
          method: 'context.update',
          args: { sessionId, messages: rows.slice(-16), modelLabel: label }
        }).catch(() => {});
      }, 50);
    }, [props.sessionId, props.message.id, props.message.content]);
    return null;
  }

  const slots = [
    pi.slots.register({ slot: 'userAction', positions: ['left'], component: Capture }),
    pi.slots.register({ slot: 'assistantAction', positions: ['left'], component: Capture })
  ];

  dispose = () => {
    clearTimeout(updateTimer);
    slots.forEach(d => d());
  };
  return dispose;
}

export function onUnload() {
  dispose?.();
}
