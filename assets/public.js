/* public.js —— 公开浏览页逻辑（游客免登录） */
function fmt(n) { return Number(n).toFixed(2); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let ALL = [];

function summary(rows) {
  let inc = 0, exp = 0;
  for (const r of rows) { if (r.type === 'income') inc += r.amount; else exp += r.amount; }
  return { inc, exp, bal: inc - exp };
}

function render(rows) {
  const s = summary(rows);
  document.getElementById('cInc').textContent = '¥' + fmt(s.inc);
  document.getElementById('cExp').textContent = '¥' + fmt(s.exp);
  document.getElementById('cBal').textContent = '¥' + fmt(s.bal);
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">暂无记录</td></tr>';
    return;
  }
  for (const r of rows) {
    const att = r.attachment
      ? '<a class="att-link" onclick="viewAtt(' + r.id + ')">查看佐证</a>'
      : '<span class="att-none">无（初始导入）</span>';
    tbody.innerHTML += '<tr>' +
      '<td>' + esc(r.date) + '</td>' +
      '<td><span class="tag ' + r.type + '">' + (r.type === 'income' ? '收入' : '支出') + '</span></td>' +
      '<td class="amt">¥' + fmt(r.amount) + '</td>' +
      '<td>' + esc(r.desc) + '</td>' +
      '<td>' + esc(r.handler) + '</td>' +
      '<td>' + att + '</td></tr>';
  }
}

function viewAtt(id) {
  const r = ALL.find(x => x.id === id);
  if (!r || !r.attachment) return;
  const w = window.open('');
  w.document.write('<title>佐证附件</title><body style="margin:0"><img style="max-width:100%" src="' + r.attachment + '"></body>');
}

function applyFilter() {
  const start = document.getElementById('start').value.trim();
  const end = document.getElementById('end').value.trim();
  let rows = ALL;
  if (start) rows = rows.filter(r => r.date >= start);
  if (end) rows = rows.filter(r => r.date <= end);
  render(rows);
}

function exportXlsx() {
  const start = document.getElementById('start').value.trim();
  const end = document.getElementById('end').value.trim();
  let rows = ALL;
  if (start) rows = rows.filter(r => r.date >= start);
  if (end) rows = rows.filter(r => r.date <= end);
  const s = summary(rows);
  const wb = XLSX.utils.book_new();
  const data = [
    ['金牛生态小区E1栋一单元电梯公共资金收支明细'],
    ['统计区间', (start || '最早') + ' 至 ' + (end || '最新')],
    ['总收入(元)', Math.round(s.inc * 100) / 100],
    ['总支出(元)', Math.round(s.exp * 100) / 100],
    ['账户余额(元)', Math.round(s.bal * 100) / 100],
    [],
    ['日期', '类型', '金额(元)', '事项说明', '经办人', '录入人']
  ];
  for (const r of rows)
    data.push([r.date, r.type === 'income' ? '收入' : '支出', Math.round(r.amount * 100) / 100, r.desc, r.handler, r.created_by]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), '收支明细');
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  XLSX.writeFile(wb, 'E1电梯资金收支明细_' + ts + '.xlsx');
}

document.addEventListener('DOMContentLoaded', async () => {
  await Store.ensureSeed();
  ALL = await Store.listRecords();
  render(ALL);
  document.getElementById('btnFilter').onclick = applyFilter;
  document.getElementById('btnReset').onclick = () => { document.getElementById('start').value = ''; document.getElementById('end').value = ''; render(ALL); };
  document.getElementById('btnExport').onclick = exportXlsx;
});
