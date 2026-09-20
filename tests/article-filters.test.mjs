import assert from 'node:assert/strict'
import test from 'node:test'
import { isDisambiguationTitle, isDayArticle, isYearArticle, isYearOrDayArticle } from '../src/graph/articleFilters.ts'

test('disambiguation title suffixes are identified case-insensitively', () => {
  assert.equal(isDisambiguationTitle('Mercury (disambiguation)'), true)
  assert.equal(isDisambiguationTitle('Mercury (Disambiguation) '), true)
  assert.equal(isDisambiguationTitle('Mercury'), false)
  assert.equal(isDisambiguationTitle('Disambiguation needed'), false)
})

test('calendar filters remain narrow', () => {
  assert.equal(isYearArticle('2024'), true)
  assert.equal(isDayArticle('January 1'), true)
  assert.equal(isYearOrDayArticle('2024 in music'), false)
})
