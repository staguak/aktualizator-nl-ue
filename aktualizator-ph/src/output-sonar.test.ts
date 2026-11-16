import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOutput} from './output.js';

test('line ending, trailing-space and final-newline normalization retains canonical bytes',()=>{
  assert.equal(normalizeOutput('alpha  \r\n  beta \t\r\n\r\n'),'alpha\n  beta\n');
  assert.equal(normalizeOutput('\n\n'),'\n');
  assert.equal(normalizeOutput('  x  y'),'  x  y\n');
  assert.equal(normalizeOutput('a\rb\rc'),'a\nb\nc\n');
  assert.equal(normalizeOutput(''), '\n');
});
test('large indentation before regular text remains intact',()=>{
  const input=' '.repeat(50000)+'x';
  assert.equal(normalizeOutput(input),input+'\n');
});

test('U+2028/U+2029 line separators preserve their code points while trimming preceding blanks',()=>{
  assert.equal(normalizeOutput('a  \u2028b \t\u2029'), 'a\u2028b\u2029\n');
});
