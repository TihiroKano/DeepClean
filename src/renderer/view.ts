/**
 * 视图 id 单独一层，不放 `App.tsx`。
 *
 * 为什么：首页的「快速入口」六格要按 id 跳页，而 `App.tsx` 本来就 import 首页 ——
 * 类型再从 `App.tsx` 引回去就成了一圈循环 import。它现在**只是**被 TS 擦掉的类型所以不出事，
 * 但"靠擦除才不断环"这种形状下次改动（有人把它换成一个运行时常量）就会当场炸，
 * 所以别把环留在原地。
 */
export type View = 'home' | 'map' | 'cleanup' | 'devenv' | 'journal' | 'settings'
