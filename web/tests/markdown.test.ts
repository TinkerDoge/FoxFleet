import { describe, expect, it } from 'vitest';
import { enhance, renderMarkdown } from '../src/lib/markdown';

const dom = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d; };

describe('markdown sanitizer', () => {
  it('renders tables, code, lists, emphasis', () => {
    const d = dom(renderMarkdown('# Hi\n\n**b** _i_ `c`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```\n\n- one\n- two'));
    expect(d.querySelector('h1')?.textContent).toBe('Hi'); expect(d.querySelectorAll('td').length).toBe(2);
    expect(d.querySelector('pre code')?.textContent).toContain('let x'); expect(d.querySelectorAll('li').length).toBe(2);
  });
  it.each([
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '[x](javascript:alert(1))', '[x](  JaVaScRiPt:alert(1))',
    '<iframe src="https://evil.example"></iframe>', '<svg onload=alert(1)><circle/></svg>', '<div style="background:url(javascript:alert(1))">x</div>',
    '<form action="https://evil.example"><input name=a></form>', '![x](javascript:alert(1))', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', '<style>*{display:none}</style>',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)', '<object data="https://evil.example"></object>',
  ])('neutralises %s', (src) => {
    const html = renderMarkdown(src); const d = dom(html);
    expect(d.querySelector('script,iframe,object,embed,form,style,svg,math')).toBeNull();
    expect(html).not.toMatch(/onerror|onload|javascript:|style=/i);
    d.querySelectorAll('a').forEach((a) => expect(a.getAttribute('href') ?? 'https://ok').toMatch(/^(https?:|mailto:|#)/i));
    d.querySelectorAll('img').forEach((i) => expect(i.getAttribute('src')).toMatch(/^(https:\/\/|data:image\/|\/api\/)/));
  });
  it('opens links safely', () => {
    const a = dom(renderMarkdown('[site](https://example.com/x)')).querySelector('a')!;
    expect(a.target).toBe('_blank'); expect(a.rel).toContain('noopener'); expect(a.rel).toContain('noreferrer');
    expect(dom(renderMarkdown('[top](#top)')).querySelector('a')!.getAttribute('target')).toBeNull();
  });
  it('only allows https, data-image or hub-media images', () => {
    expect(dom(renderMarkdown('![a](http://insecure.example/a.png)')).querySelector('img')).toBeNull();
    expect(dom(renderMarkdown('![a](https://example.com/a.png)')).querySelector('img')?.hasAttribute('data-viewable')).toBe(true);
    expect(dom(renderMarkdown('![a](/api/agents/atlas/media?path=a.png)')).querySelector('img')).not.toBeNull();
  });
  it('wraps code blocks with a copy button and tables for scrolling, idempotently', () => {
    const d = dom(renderMarkdown('```python\nprint(1)\n```\n\n| a |\n|---|\n| 1 |'));
    enhance(d); enhance(d);
    expect(d.querySelectorAll('.code').length).toBe(1); expect(d.querySelectorAll('button[data-copy]').length).toBe(1);
    expect(d.querySelector('.code-bar span')?.textContent).toBe('python'); expect(d.querySelectorAll('.table-wrap').length).toBe(1);
  });
});
