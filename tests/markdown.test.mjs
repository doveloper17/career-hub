import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function render(input) {
  return execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    'import fs from "node:fs"; import { markdown } from "./src/lib/view.ts"; process.stdout.write(markdown(fs.readFileSync(0, "utf8")));'],
  { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

test('Mermaid 구문과 개행용 HTML은 실행되지 않는 코드로 보존한다', () => {
  const html = render('```mermaid\nflowchart LR\nA["수집<br/>APP"] --> B["저장"]\n```');
  assert.match(html, /<pre class="mermaid"><code>/);
  assert.match(html, /&lt;br\/?&gt;/);
  assert.doesNotMatch(html, /<br/);
});

test('일반 코드와 잘못된 Mermaid는 원문을 보존하고 실행 HTML은 제거한다', () => {
  assert.doesNotMatch(render('```js\nconst answer = 42;\n```'), /class="mermaid"/);
  assert.match(render('```mermaid\ninvalid diagram\n```'), /invalid diagram/);
  const html = render('```mermaid\n</code></pre><script>alert(1)</script>\n```\n<img src=x onerror=alert(1)><script>alert(2)</script>');
  assert.doesNotMatch(html, /<script|<img|onerror=/);
  assert.match(html, /&lt;script&gt;/);
});
