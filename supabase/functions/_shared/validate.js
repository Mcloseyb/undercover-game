export function validateBank(data) {
  if (!data || typeof data.name !== 'string' || !data.name.trim() || [...data.name.trim()].length > 24) throw Error('词库名称需要 1～24 个字');
  if (!Array.isArray(data.pairs) || data.pairs.length < 2 || data.pairs.length > 2000) throw Error('词库需要 2～2000 组词语');
  const seen = new Set();
  const pairs = data.pairs.map((p, i) => {
    if (!p || !['civilian','undercover'].every(k => typeof p[k] === 'string' && p[k].trim() && [...p[k].trim()].length <= 24 && !/[\x00-\x1f\x7f]/.test(p[k]))) throw Error(`第 ${i+1} 组：词语需为 1～24 个字，不能含控制字符`);
    const pair = { civilian:p.civilian.trim(), undercover:p.undercover.trim() };
    if (pair.civilian === pair.undercover) throw Error(`第 ${i+1} 组：平民词与卧底词不能相同`);
    const key = [pair.civilian,pair.undercover].sort().join('\0');
    if (seen.has(key)) throw Error(`第 ${i+1} 组：存在重复配对`);
    seen.add(key); return pair;
  });
  return {name:data.name.trim(),pairs};
}
export function validateFilename(name) {
  if (typeof name !== 'string' || name.length > 100 || /[\\/\x00-\x1f]/.test(name) || name.includes('..') || !/\.(json|csv)$/i.test(name)) throw Error('仅支持合法文件名的 JSON 或 CSV 文件');
  return name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
}
