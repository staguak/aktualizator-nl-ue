import test from 'node:test';
import assert from 'node:assert/strict';
import {simpleCssRules} from './css-rules.js';

test('linear CSS rule scanner preserves legacy non-nested selector/body matches',()=>{
  const fixtures=[
    '.literal { white-space: pre; }',
    'h1{color:red} p{ white-space: pre-wrap; }',
    'ignored {outer { white-space: nowrap; } tail }',
    '}}a{b}{x}a{b}', 'a{{b}', '{a{b}', 'a{b}x{c}',
    '\n  .a, .b {white-space: pre; color: red}\n',
  ];
  for(const text of fixtures){
    const expected=[...text.matchAll(/([^{}]+)\\{([^{}]*)\\}/g)].map(m=>[m[1],m[2]]);
    assert.deepEqual([...simpleCssRules(text)],expected,text);
  }
});

test('many unmatched braces are processed without quadratic backtracking',()=>{
  const css='x'.repeat(80000)+'{'.repeat(80000)+'a{white-space:pre}';
  assert.deepEqual([...simpleCssRules(css)],[['a','white-space:pre']]);
});
