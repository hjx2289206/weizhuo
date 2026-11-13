import test from 'node:test'
import assert from 'node:assert/strict'
import { lobbyScale, LOBBY_WIDTH } from '../src/useLobbyScale'

test('the whole lobby fits phone landscape in both axes, including a taller resume or invite panel', () => {
  for (const [width, height] of [[844, 390], [667, 375], [932, 430], [740, 360]]) {
    for (const contentHeight of [480, 560, 820]) {
      const scale = lobbyScale(width!, height!, contentHeight)
      assert.ok(LOBBY_WIDTH * scale <= width! + .001)
      assert.ok(contentHeight * scale <= height! + .001)
      assert.ok(scale > 0 && scale <= 1)
    }
  }
  assert.equal(lobbyScale(1600, 1200, 600), 1, 'desktop canvas is never magnified')
})
