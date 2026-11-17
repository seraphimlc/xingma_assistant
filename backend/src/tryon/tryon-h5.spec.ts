import * as fs from 'fs';
import * as path from 'path';

function extractFn(src: string, name: string): Function {
  const start = src.indexOf('function ' + name);
  if (start < 0) throw new Error('missing ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        const text = src.slice(start, i + 1);
        return new Function(`return (${text});`)() as Function;
      }
    }
  }
  throw new Error('unclosed ' + name);
}

describe('try-on H5', () => {
  const root = path.join(__dirname, '..', '..', 'public', 'tryon');
  const js = fs.readFileSync(path.join(root, 'tryon.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  it('passes a finite fps into captureStream and keeps canvas size a positive integer', () => {
    const finiteFps = extractFn(js, 'finiteFps') as (value: unknown, fallback?: number) => number;
    const positiveInt = extractFn(js, 'positiveInt') as (value: unknown, fallback?: number) => number;
    expect(finiteFps({ ideal: 30, max: 30 })).toBe(30);
    expect(finiteFps(0)).toBe(1);
    expect(finiteFps(99)).toBe(60);
    expect(finiteFps('nope', 24)).toBe(24);
    expect(positiveInt(0, 720)).toBe(720);
    expect(positiveInt(1280.4, 720)).toBe(1280);
    expect(js).toMatch(/captureStream\(fps\)/);
    expect(js).not.toMatch(/captureStream\(\s*\{/);
    expect(js).toMatch(/canvas\.width = width/);
    expect(js).toMatch(/canvas\.height = height/);
  });

  it('starts Lucy VTON only from the start button and explains the WeChat camera fallback', () => {
    expect(js.indexOf('function startSession')).toBeLessThan(js.indexOf('realtime.connect'));
    expect(js.indexOf("goBtn.addEventListener('click'")).toBeGreaterThan(0);
    expect(js).toContain('lucy-vton-latest');
    expect(js).not.toMatch(/切换模型|XMax|X2\.0/);
    expect(js).toContain('在浏览器中打开');
    expect(html).toContain('开始试衣');
    expect(html).toContain('vendor/decart.js');
    expect(html).not.toContain('live.visitworld.me');
  });
});
