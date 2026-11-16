import test from 'node:test';
import assert from 'node:assert/strict';
import {simpleCssRules} from './css-rules.js';

test('linear CSS rule scanner preserves legacy non-nested selector/body matches',()=>{
  const fixtures:{css:string;expected:string[][]}[]=[
    {css:'.literal { white-space: pre; }',expected:[['.literal ',' white-space: pre; ']]},
    {css:'h1{color:red} p{ white-space: pre-wrap; }',expected:[['h1','color:red'],[' p',' white-space: pre-wrap; ']]},
    {css:'ignored {outer { white-space: nowrap; } tail }',expected:[['outer ',' white-space: nowrap; ']]},
    {css:'}}a{b}{x}a{b}',expected:[['a','b'],['a','b']]},
    {css:'a{{b}',expected:[]},
    {css:'{a{b}',expected:[['a','b']]},
    {css:'a{b}x{c}',expected:[['a','b'],['x','c']]},
    {css:'\n  .a, .b {white-space: pre; color: red}\n',expected:[['\n  .a, .b ','white-space: pre; color: red']]},
  ];
  for(const {css,expected} of fixtures)assert.deepEqual([...simpleCssRules(css)],expected,css);
});

test('many unmatched braces are processed without quadratic backtracking',()=>{
  const css='x'.repeat(80000)+'{'.repeat(80000)+'a{white-space:pre}';
  assert.deepEqual([...simpleCssRules(css)],[['a','white-space:pre']]);
});
