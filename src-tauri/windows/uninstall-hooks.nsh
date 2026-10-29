; tauri 的 NSIS 卸载器会删掉 ARP 键、快捷方式与 $INSTDIR 里的文件，
; 但把 `HKLM:\SOFTWARE\<发布者>\<产品名>` 这把**安装位置**键留在机器上，
; 默认值还指着那个已经不存在的目录。2026-10-17 Task 6 装机验收实测抓到的
; （`scripts/m6-install-verify.ps1 -Phase residue` 红在这里）。
;
; 一把"注册表说这东西装在 C:\Program Files\DeepClean，而卸载表里查无此项"的键，
; 正是本产品自己拿来判残留的那一类形状 —— 交付物不该留下它自己要扫的东西。
;
; 变量名是从模板里**探**出来的，不是查文档查到的：第一版这里写的是
; `Software\${PUBLISHER}\${PRODUCT_NAME}`，而这两个名字模板里根本没有 ——
; NSIS 对未定义变量**原样留字面量**，于是 DeleteRegKey 打在一把不存在的键上，
; 静默成功、什么也没删（makensis 也不报错）。判据那侧同样静默通过，直到复跑才露出来。
; 探法：在宏体里放 `!error "...=${NAME}..."`，已定义的会展开成值、未定义的留字面量。
; 实测展开：MANUFACTURER=TihiroKano、PRODUCTNAME=DeepClean、MAINBINARYNAME=deepclean-app；
; 而 PUBLISHER / PUBLISHER_NAME / PRODUCT_NAME / VENDOR / COMPANY / IDENTIFIER 全是字面量。
;
; 只删产品那一层。**不动** `SOFTWARE\TihiroKano`：同一发布者名下若还有别的应用，
; 顺手拆父键会把它们的家也拆了；留一把空的公司键是可接受的，拆错家不是。
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKLM "Software\${MANUFACTURER}\${PRODUCTNAME}"
!macroend
