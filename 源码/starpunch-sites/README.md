# 星光打卡：Sites 云端 + Windows 单文件员工端

Sites project: appgprj_6ac49b84d3308191b35502e6bef44b2c

Employee client: https://starpunch-attendance.ewofts.chatgpt.site/
Administrator: https://starpunch-attendance.ewofts.chatgpt.site/admin

员工在 EXE 输入管理员生成的一次性绑定码。每个员工最多绑定一台电脑，每台电脑最多绑定一名员工。服务端保存凭据哈希；Windows 客户端用 DPAPI 加密保存设备凭据，同时校验 MachineGuid 的 SHA256。普通网页没有设备桥接，不能登记电脑。换电脑先由管理员解绑。

管理员首次用 Sites Secret `BOOTSTRAP_CODE` 初始化密码。密码采用 scrypt，管理会话 HttpOnly、Secure、SameSite=Strict；员工凭据不能调用管理接口。不要把 Sites 服务访问令牌或源代码仓库凭据放进 EXE。

`domain/rules.cjs` 同一源码用于后台计算及浏览器 `/rules.js`。工资按发薪周期计算：默认 9 月 15 日至 10 月 14 日，于 10 月 15 日结算，15 日开始新一期。日薪 = 月薪 ÷ 周期实际天数，整期全勤等于月薪，提成也按同一日期区间汇总。后台和员工端显示本期累计、明确起止日期，未发工资包含本期累计及历史未发结算；考勤日历仍按自然月查看，各天按所属工资周期计薪。

升级时旧自然月未发结算移入 `payrollArchive` 并重新生成，已发金额保留；新结算排除旧已发记录覆盖的日期及业绩，避免重复发放。归档包含在数据备份中。修改考勤、业绩或批量跨周期修改会重算对应未发周期。变更发薪日也会保留已发记录、归档未发记录后重建。

数据保存在 D1 的 `starpunch_state`，按 revision 乐观锁提交；冲突会重跑请求。`starpunch_backups` 保留每日首份快照、最近 90 份。浏览器下载和快照下载均移除密码哈希与设备凭据。原 v1/v2 备份可在后台导入，不自动上传本机旧数据。

## 运行与验证

考勤修改原因可留空，系统仍保存修改时间和前后状态。考勤页「批量编辑」支持多员工、日期范围和统一状态（含恢复自动判断），保留原始打卡时间与工作记录，跳过非在职日期。每批最多 366 天、1000 条，整批原子提交，未发放结算按员工工资周期重算。

管理员在考勤日期弹窗可直接选择正常、迟到、任务超时、迟到且超时或缺勤。记录的 `manualStatus` 优先于打卡时间判定，保留原始时间与原因审计；选择自动判断可撤销。各状态仍使用原有薪资比例，未发放结算同步重算，已发放金额锁定。员工不能更改人工指定状态。

- `npm ci`，`npm run build`，`npm run db:generate`（只在 schema 变更时）。
- 本地迁移：`node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_even_argent.sql`。
- 本地预览：`npm start -- --port 5178 --var BOOTSTRAP_CODE:local-test-only`。该测试码仅用于本地，生产值由 Sites Secret 提供。
- `node --test test/integration.test.js` 测试持久化、并发写入、权限隔离、绑定、解绑、考勤截止、提成及已发放快照锁定。
- 生产变更使用 Sites source helper 提交、推送、构建、打包，再发布对应 commit；保留项目 ID 与 D1 数据。

## 无人值守维护

每日北京时间 00:05 的 Sites 云端任务请求 `GET /api/system/maintenance`。此操作不接受业务参数，只根据云端时间生成应到期的结算与当日快照，重复请求不会重复结算。成功响应为 `{ "ok": true }`；失败需报告。常规业务请求也补做应到期结算。

维护任务无需管理员 Cookie、员工凭据或本机 EXE。若 Sites 平台入口受限，先通过 get_site 获取当次服务访问令牌，仅用于该站点，不保存、不输出；公开入口则直接请求。不要重置数据库、伪造考勤或重新发布网站。

客户端源码位于同工作目录的 `starpunch-client-sites`；发行版不接受测试 URL / 数据目录环境覆盖。旧单机 EXE 数据目录与云端客户端分离。
