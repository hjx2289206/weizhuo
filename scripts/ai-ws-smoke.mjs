// Exercise a listening server via its public WebSocket protocol.
import assert from 'node:assert/strict';
import WebSocket from 'ws';

for (const game of ['guandan', 'doudizhu']) {
  const ws = new WebSocket(process.env.AI_TEST_WS || 'ws://127.0.0.1:5180/ws');
  const messages = [];
  let sequence = 0;
  ws.on('message', data => messages.push(JSON.parse(String(data))));
  const until = async predicate => {
    const deadline = Date.now() + 40000;
    while (!predicate()) {
      const error = messages.find(message => message.type === 'error');
      if (error) throw Error(JSON.stringify(error));
      if (Date.now() > deadline) throw Error(`WebSocket smoke timed out: ${game}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const send = async (type, payload) => {
    const id = `cpu-${++sequence}`;
    ws.send(JSON.stringify({ type, id, payload }));
    await until(() => messages.some(message => message.type === 'ack' && message.id === id));
  };
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await send('create', { roomMode: 'phone', game, name: 'CPU验证' });
    await until(() => messages.some(message => message.type === 'state'));
    const state = () => messages.filter(message => message.type === 'state').at(-1).state;
    assert.equal(state().automation.available, true, JSON.stringify(state().automation));
    for (let seat = 1; seat < (game === 'guandan' ? 4 : 3); seat++) {
      await send('addBot', { seatId: seat, strength: seat % 2 ? 'strong' : 'easy' });
    }
    await send('autoPlay', { enabled: true });
    await send('start', {});
    await until(() => state().tablePlays.length >= 2);
    assert.equal(state().automation.available, true);
    console.log(JSON.stringify({ game, room: state().code, acceptedPlays: state().tablePlays.length, automation: state().automation }));
  } finally {
    ws.close();
  }
}
