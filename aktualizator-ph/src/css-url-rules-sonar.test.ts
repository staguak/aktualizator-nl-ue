import test from 'node:test';
import assert from 'node:assert/strict';
import {cssUrlMatches,replaceCssUrls} from './css-url-rules.js';

test('linear CSS URL scanning preserves legacy match position, payload and replacement',()=>{
  const fixtures=[
    'body{background:url(icon.png)}',
    'a{src: URL( "file with space.svg" )}',
    "b{src:url('data:image/png;base64,AAAA==')}",
    'url() url(    ) url( x )',
    'unmatched url("foo x) and url(next.png)',
    'url(a url(nested.png) trailing',
    'url("q\"uote") url("")',
    'url(\u00a0big\u00a0)',
    'url(x\n) URL(y)',
    'unknownurl(http://legal.example/img.png)',
    'url(hello)x url(foo) y',
  ];
  const legacy=/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi;
  for(const fixture of fixtures){
    const expected=[...fixture.matchAll(legacy)].map(m=>({
      start:m.index!,end:m.index!+m[0].length,text:m[0],source:m[1]??m[2]??m[3],
    }));
    assert.deepEqual([...cssUrlMatches(fixture)],expected,fixture);
    assert.equal(replaceCssUrls(fixture,m=>`[${m.source}]`),
      fixture.replace(legacy,(_whole,a,b,c)=>`[${a??b??c}]`),fixture);
  }
});
test('long malformed nested CSS URL tokens are handled without backtracking',()=>{
  const css='url('.repeat(20000)+'x '+ 'url(valid.png)';
  assert.deepEqual([...cssUrlMatches(css)].map(m=>m.source),['valid.png']);
});
