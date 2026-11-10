/** 联网验证新浪搜索及三种报价格式，不改动用户自选。先 npm run build。 */
const { FuturesSearch } = require('../dist/features/futures/search.js');
const { CommodityProvider, registerCommodity } = require('../dist/features/commodities/data.js');
async function main() {
  const search = new FuturesSearch(),
    selected = new Map();
  for (const [query, code] of [
    ['螺纹钢', 'RB0'],
    ['沪金', 'AU0'],
    ['碳酸锂', 'LC0'],
    ['IF', 'IF0'],
    ['国债', 'T0'],
    ['标普', 'ES'],
    ['日经', 'NK'],
    ['纳指', 'NQ']
  ]) {
    const found = await search.search(query);
    const entry = found.find((item) => item.code === code);
    if (!entry) throw new Error(`${query} 未返回 ${code}`);
    selected.set(code, registerCommodity(entry));
    if (code === 'LC0') {
      const month = found.find((item) => /^LC\d{4}$/.test(item.code));
      if (!month) throw new Error('碳酸锂未返回在市月份合约');
      selected.set(month.code, registerCommodity(month));
    }
    console.log(`搜索 ${query} → ${entry.name} ${entry.code}，共${found.length}项`);
  }
  const result = await new CommodityProvider().load([...selected.keys()]);
  if (result.errors.size) throw new Error(JSON.stringify([...result.errors]));
  for (const [code, quote] of result.quotes)
    console.log(
      `${selected.get(code).name} ${code} ${quote.priceText} ${quote.percent?.toFixed(2)}% ${quote.date} ${quote.time}`
    );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
