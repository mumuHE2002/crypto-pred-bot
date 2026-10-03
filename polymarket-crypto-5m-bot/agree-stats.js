// 双模型同向判断准确率统计：含未达注额被跳过的数据
// 用法: node agree-stats.js
const { fetchSettlement } = require('./src/polymarket');

const fs = require('fs');
function load(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function main() {
  const cur = load('./data/ledger.json');
  const bak = load('./data/ledger.json.bak-20261002-1135');
  const bySlug = new Map();
  for (const L of [bak, cur]) {
    if (!L) continue;
    for (const j of (L.judgments || [])) {
      if (!j || !j.slug) continue;
      if (!bySlug.has(j.slug)) bySlug.set(j.slug, j);
    }
  }
  // 结算表：slug+side -> win
  const settleWin = new Map();
  for (const L of [bak, cur]) {
    if (!L) continue;
    for (const s of (L.settlements || [])) {
      if (s && s.slug) settleWin.set(s.slug + '|' + s.side, !!s.win);
    }
  }

  const agree = [...bySlug.values()].filter(j =>
    (j.dsDirection === 'up' || j.dsDirection === 'down') && j.dsDirection === j.museDirection);
  console.log(`双模型同向判断总数: ${agree.length}`);

  const rows = [];
  let pending = 0;
  for (const j of agree) {
    const dir = j.dsDirection;
    let actual = null;
    const w = settleWin.get(j.slug + '|' + dir);
    if (w !== undefined) {
      actual = w ? dir : (dir === 'up' ? 'down' : 'up');
    } else {
      try {
        const s = await fetchSettlement(j.slug);
        if (s.found && (s.upWon || s.downWon)) actual = s.upWon ? 'up' : 'down';
        else { pending++; continue; }
      } catch (e) { pending++; continue; }
    }
    rows.push({
      label: j.windowLabel, coin: j.coin, dir,
      bet: !!j.bet,
      minConf: Math.min(j.dsConfidence || 0, j.museConfidence || 0),
      correct: actual === dir,
    });
  }

  const show = (name, list) => {
    if (!list.length) { console.log(`${name}: 无数据`); return; }
    const hit = list.filter(r => r.correct).length;
    console.log(`${name}: ${hit}/${list.length} = ${(hit / list.length * 100).toFixed(1)}%`);
  };
  show('全部同向', rows);
  show('  其中已下注', rows.filter(r => r.bet));
  show('  其中被跳过(未达注额/其它)', rows.filter(r => !r.bet));
  show('  同向看涨(up)', rows.filter(r => r.dir === 'up'));
  show('  同向看跌(down)', rows.filter(r => r.dir === 'down'));
  show('  跳过且看涨', rows.filter(r => !r.bet && r.dir === 'up'));
  show('  跳过且看跌', rows.filter(r => !r.bet && r.dir === 'down'));
  console.log(`待结算/查不到官方结果: ${pending} 个`);

  // 置信度分布：同向但跳过的主要原因
  const skipped = rows.filter(r => !r.bet);
  const lowConf = skipped.filter(r => r.minConf < 0.57).length;
  console.log(`跳过中因较低置信度<57%被跳过: ${lowConf}/${skipped.length}`);
  const hitByTier = {};
  for (const r of rows) {
    const tier = r.minConf < 0.57 ? '<57%' : r.minConf <= 0.60 ? '57-60%' : r.minConf <= 0.70 ? '61-70%' : '>=71%';
    hitByTier[tier] = hitByTier[tier] || { hit: 0, n: 0 };
    hitByTier[tier].n++; if (r.correct) hitByTier[tier].hit++;
  }
  console.log('按较低置信度分档的准确率:');
  for (const [t, v] of Object.entries(hitByTier))
    console.log(`  ${t}: ${v.hit}/${v.n} = ${(v.hit / v.n * 100).toFixed(1)}%`);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
