import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

export function readModelEvents(lines) {
  let final = null;
  let tokens = 0;
  let metered = false;
  for (const line of lines.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') final = event.item.text;
    if (event.type === 'item.started' || event.type === 'item.completed') {
      if (['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(event.item?.type)) throw new Error('도구 사용이 금지된 역할에서 도구 실행 이벤트가 발생했습니다.');
    }
    if (event.type === 'turn.failed' || event.type === 'error') throw new Error('모델 실행이 실패했습니다. 저장된 단계에서 재개하세요.');
    if (event.type === 'turn.completed' && event.usage) {
      const u = event.usage;
      if (Number.isSafeInteger(u.input_tokens) && u.input_tokens >= 0 && Number.isSafeInteger(u.output_tokens) && u.output_tokens >= 0) {
        tokens += u.input_tokens + u.output_tokens; metered = true;
      }
    }
  }
  return { final, tokens, metered };
}

export function invokeModel(args, { cwd, env, input, timeoutMs, signal, onUsage = () => {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', total = 0, final = null, tokens = 0, metered = false, failure = null;
    const fail = error => { failure ||= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail(new Error('모델 실행 시간 한도 도달')), timeoutMs);
    const abort = () => fail(new Error('사용자가 모델 실행을 중단했습니다.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const consume = line => {
      try {
        const parsed = readModelEvents(line);
        if (parsed.final !== null) final = parsed.final;
        if (parsed.metered) {
          tokens += parsed.tokens; metered = true;
          onUsage({ tokens: parsed.tokens, metered: true });
        }
      } catch (error) { fail(error); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', bytes => {
      total += Buffer.byteLength(bytes);
      if (total > 4 * 1024 * 1024) return fail(new Error('모델 출력 크기 한도 도달'));
      buffer += bytes.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    // Stderr may contain user material or authentication diagnostics; never print it.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => { failure ||= new Error('Codex 프로세스를 실행할 수 없습니다.'); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (buffer.trim()) consume(buffer);
      if (failure || code !== 0 || final === null) return reject(failure || new Error('모델 결과가 없거나 프로세스가 중단되었습니다.'));
      resolve({ text: final, usage: { tokens, metered } });
    });
    child.stdin.end(input);
  });
}
