// 手动触发：梯队评价表考勤时长回填（默认 dry-run；--confirm 才写表）
// 用法：
//   node scripts/roster-fill.js --week-start 2026-10-12          # 预览第一组（10.12-10.18）
//   node scripts/roster-fill.js --week-start 2026-10-12 --confirm # 正式写入
//   node scripts/roster-fill.js                                  # 默认取上一周周一
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const plugin = require('../src/plugins/rosterFill');

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const weekStart = argValue('--week-start') || plugin.previousWeekStart();
const confirm = args.includes('--confirm');
const overwrite = !args.includes('--no-overwrite');

(async () => {
  const r = await plugin.fillWeek({ weekStartStr: weekStart, dryRun: !confirm, overwrite });
  console.log(`目标：${r.weekStart} ~ ${r.weekEnd} · 第 ${r.groupIndex + 1} 组（${r.period}）· ${r.dryRun ? 'dry-run 预览' : '写入'}`);
  for (const p of r.plan.slice().sort((a, b) => b.hours - a.hours)) {
    console.log(`  ${p.name}：${p.old == null ? '空' : p.old} → ${p.hours}h（${p.punchDays} 天 / ${p.completeSessions} 段${p.missingSessions ? ` / 缺卡 ${p.missingSessions}` : ''}）`);
  }
  if (r.unmatched.length) {
    console.log(`未匹配（该行不回写）：${r.unmatched.map((u) => `${u.name}${u.openId ? '/' + u.openId : ''}`).join('、')}`);
  }
  if (r.skipped.length) {
    console.log(`跳过（已有值，--no-overwrite）：${r.skipped.map((s) => `${s.name}=${s.old}`).join('、')}`);
  }
  console.log(r.dryRun
    ? `预览 ${r.plan.length} 条；加 --confirm 正式写入`
    : `已写入 ${r.updated} 条`);
})().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});
