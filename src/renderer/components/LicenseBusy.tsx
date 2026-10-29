/**
 * 授权卡里的「校验中」那一相 —— 莫比乌斯环 + 一句话（2026-10-27）。
 *
 * **为什么单独一个文件而不是写在 `Settings.tsx` 里**：`LicenseCard` 要 import 它，
 * 而 `Settings` 要 import `LicenseCard` —— 放一起就绕回去了（`Settings → LicenseCard
 * → Settings` 那个环在 ESM 里表现为其中一侧拿到 `undefined`，报错信息还指向别处）。
 * 一个只依赖 `MobiusSpinner` 的小组件放在这一层，谁都能引。
 *
 * 抽成导出组件也是为了判据能直接渲染它（本仓没装 jsdom，
 * 与 `LicensePanel` / `JournalEmpty` 同一处先例）。
 *
 * ## 2026-10-27 晚：文案改成**分阶段**的
 *
 * 人类伙伴：「加载动画加个服务器通讯中......，这点点要会动」。
 *
 * 原来的文案是一句静态的「正在校验激活码…」，而这条链上真正发生的事是**两段**：
 * 先过网络闸（`netprobe` 的 TCP 探测），再进本地判定（码表比对 + 设备签名）。
 * 两段的失败原因完全不同，用户看到的进度也该分开。
 *
 * 三个点自己会动（`.dc-dots` 的 CSS 动画），**不是**把省略号写进字符串里靠计时器
 * 换文本 —— 后者每换一次都会重排一次这行字，且判据只能靠假计时器测。
 */
import { MobiusSpinner } from './MobiusSpinner'

/** 三个会动的点。纯装饰，读屏不念（`aria-hidden`），语义由 `label` 承担。 */
function Dots(): JSX.Element {
  return (
    <span className="dc-dots" aria-hidden="true">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  )
}

export function LicenseBusy({ label = '正在校验激活码' }: { label?: string }): JSX.Element {
  return (
    <div className="dc-license-busy">
      <MobiusSpinner label={label} trailing={<Dots />} />
    </div>
  )
}
