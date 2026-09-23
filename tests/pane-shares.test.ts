import { describe, expect, it } from 'vitest'
import { clampShares, resizeShares } from '../src/renderer/src/App'

/* 样式表里的默认份额：导航 17.5%、列表 22%（内容吃剩余 60.5%）。
   这里写成字面量是**故意**的 —— 如果哪天有人改了样式表而没同步这个测试，
   下面「默认值在最小窗口下不被夹动」那条会先炸，正好提醒他两边对一下。 */
const DEFAULT = { nav: 17.5, list: 22 }

/* 窗口下限（src/main/index.ts 的 minWidth）与三栏下限（App.tsx 的 PANE_LIMITS） */
const MIN_WINDOW = 1200
const WIDE = 2560

describe('分区拖拽的份额运算', () => {
  describe('拖动只影响相邻两栏', () => {
    it('拖导航那条：导航与列表此消彼长，两者之和不变（内容栏纹丝不动）', () => {
      const before = DEFAULT.nav + DEFAULT.list
      const next = resizeShares(0, DEFAULT, 4)
      expect(next.nav).toBeCloseTo(DEFAULT.nav + 4, 4)
      expect(next.list).toBeCloseTo(DEFAULT.list - 4, 4)
      // 和不变 ⇒ 内容栏拿到的 100 - nav - list 也不变。这条是「只影响相邻两栏」
      // 的核心，也是唯一能证明内容栏**没有**被牵连的断言。
      expect(next.nav + next.list).toBeCloseTo(before, 6)
    })

    it('拖导航那条：反向拖动同样保持和不变', () => {
      const next = resizeShares(0, DEFAULT, -7.5)
      expect(next.nav).toBeCloseTo(DEFAULT.nav - 7.5, 4)
      expect(next.list).toBeCloseTo(DEFAULT.list + 7.5, 4)
      expect(next.nav + next.list).toBeCloseTo(DEFAULT.nav + DEFAULT.list, 6)
    })

    it('拖列表那条：导航完全不动', () => {
      const next = resizeShares(1, DEFAULT, -6)
      expect(next.nav).toBe(DEFAULT.nav)
      expect(next.list).toBeCloseTo(DEFAULT.list - 6, 4)
    })

    it('拖动量为 0 时份额不变（避免按下未移动就产生一次「自定义」）', () => {
      expect(resizeShares(0, DEFAULT, 0)).toEqual(DEFAULT)
      expect(resizeShares(1, DEFAULT, 0)).toEqual(DEFAULT)
    })
  })

  describe('下限夹取', () => {
    it('默认值在最小窗口下不该被夹动', () => {
      // 这条是整套比例的前提：若默认值在下限窗口就不合法，
      // 「任何尺寸都保持默认比例」从最小窗口那一刻起就不成立。
      expect(clampShares(DEFAULT, MIN_WINDOW)).toEqual(DEFAULT)
    })

    it('把导航拖过窄 → 夹到导航下限（200px）', () => {
      const clamped = clampShares({ nav: 5, list: 30 }, MIN_WINDOW)
      expect(clamped.nav).toBeCloseTo((200 / MIN_WINDOW) * 100, 4)
      expect(clamped.list).toBe(30)
    })

    it('把列表拖过窄 → 夹到列表下限（220px）', () => {
      const clamped = clampShares({ nav: 20, list: 2 }, MIN_WINDOW)
      expect(clamped.nav).toBe(20)
      expect(clamped.list).toBeCloseTo((220 / MIN_WINDOW) * 100, 4)
    })

    it('导航与列表一起挤到内容栏时 → 列表先让路，保证内容栏不低于 380px', () => {
      const clamped = clampShares({ nav: 40, list: 40 }, MIN_WINDOW)
      expect(clamped.nav).toBe(40)
      const content = 100 - clamped.nav - clamped.list
      expect(content).toBeCloseTo((380 / MIN_WINDOW) * 100, 4)
    })

    it('合法份额原样返回（不引入无谓抖动）', () => {
      const shares = { nav: 24, list: 28 }
      expect(clampShares(shares, MIN_WINDOW)).toEqual(shares)
    })

    it('窗宽未知（0 或负）时原样返回，不做本地除法', () => {
      expect(clampShares(DEFAULT, 0)).toEqual(DEFAULT)
      expect(clampShares(DEFAULT, -100)).toEqual(DEFAULT)
    })
  })

  describe('窗口缩小后同一个百分比不再合法', () => {
    it('宽屏下合法的窄导航，到最小窗口会被抬到下限', () => {
      const narrowNav = { nav: 10, list: 30 }
      // 2560 下 10% = 256px，远高于 200px 下限 → 原样保留
      expect(clampShares(narrowNav, WIDE).nav).toBe(10)
      // 1200 下 10% 只有 120px，不够放「MindMesh」字标 → 抬到 16.667%
      const atMin = clampShares(narrowNav, MIN_WINDOW).nav
      expect(atMin).toBeCloseTo((200 / MIN_WINDOW) * 100, 4)
      expect(atMin).toBeGreaterThan(narrowNav.nav)
    })

    it('无论怎么夹，三栏之和都不超过 100（内容栏不会被挤成负数）', () => {
      for (const shares of [
        { nav: 90, list: 90 },
        { nav: 0, list: 0 },
        { nav: 49, list: 49 },
      ]) {
        const clamped = clampShares(shares, MIN_WINDOW)
        expect(clamped.nav + clamped.list).toBeLessThanOrEqual(100)
      }
    })
  })
})

