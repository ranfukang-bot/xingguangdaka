# 星光打卡 StarPunch

小团队员工考勤、任务完成打卡与工资/提成结算系统。

- 老板：网页后台 `/admin` 管理员工、考勤、业绩、工资与备份
- 员工：在绑定的 Windows 电脑上用「星光打卡云端版.exe」打卡、查看收入

## 目录

| 路径 | 内容 |
|---|---|
| `源码/starpunch-sites` | 云端版：员工页、老板后台、考勤/工资规则引擎、API、D1 数据库、测试（当前在用） |
| `源码/starpunch-client-sites` | Windows 客户端（Electron）：打开云端页面、电脑绑定 |
| `旧单机版` | 旧的单机网页版，仅作历史参考 |
| `先读这个_给Claude的项目说明.txt` | 完整交接说明（业务规则、架构、注意事项） |

## 常用命令

```bash
# 业务测试（无需安装依赖，Node >= 22.13）
cd 源码/starpunch-sites && node --test test/integration.test.js test/payroll-cycle.test.js

# 云端构建
cd 源码/starpunch-sites && npm ci && npm run build

# 打包 Windows 客户端
cd 源码/starpunch-client-sites && npm ci && npx electron-builder --win portable
```

> 本仓库只有源码，不含线上数据库、员工数据、部署凭据和初始化码。
