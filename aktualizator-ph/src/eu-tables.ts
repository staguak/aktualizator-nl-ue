import { load } from 'cheerio';

// Split only between row groups which are not connected by rowspan. No caption,
// header, row or cell text is repeated. Oversized indivisible groups stay intact.
export function splitEuTable(html: string, limit: number): string[] {
  if (html.length <= limit) return [html];
  const $ = load(html), table = $('table').first();
  if (table.children().toArray().some((e) => !['caption', 'colgroup', 'thead', 'tbody', 'tfoot'].includes(e.tagName))) return [html];
  const bodies = table.children('tbody');
  if (bodies.length !== 1 || table.children('thead,tfoot').find('[rowspan="0"]').length) return [html];
  const body = bodies.first(), rows = body.children('tr').toArray();
  // Nonstandard source order must not move visible header/footer text across rows.
  if (body.prevAll('tfoot').length || body.nextAll('caption,thead,colgroup').length) return [html];
  if (!rows.length || body.children().length !== rows.length) return [html];
  const groups: typeof rows[] = [];
  let start = 0, until = 0;
  rows.forEach((row, index) => {
    for (const cell of $(row).children('td,th').toArray()) {
      const raw = $(cell).attr('rowspan');
      if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error('Invalid EU table rowspan.');
      const span = raw === '0' ? rows.length - index : Number(raw ?? '1');
      until = Math.max(until, Math.min(rows.length - 1, index + Math.max(1, span) - 1));
    }
    if (index >= until) { groups.push(rows.slice(start, index + 1)); start = index + 1; }
  });
  const batches: typeof groups = [];
  let batch: typeof rows = [], size = 0;
  for (const group of groups) {
    const length = group.reduce((n, row) => n + $.html(row).length, 0);
    if (batch.length && size + length > Math.max(1, limit - 4000)) { batches.push(batch); batch = []; size = 0; }
    batch.push(...group); size += length;
  }
  if (batch.length) batches.push(batch);
  if (batches.length < 2) return [html];
  return batches.map((rows, i) => {
    const copy = table.clone(), copyBody = copy.children('tbody');
    copyBody.empty();
    for (const row of rows) copyBody.append($(row).clone());
    if (i > 0) {
      copy.removeAttr('id').removeAttr('name');
      copyBody.removeAttr('id').removeAttr('name');
      copy.children('caption,thead').remove();
      copy.children('colgroup').find('[id],[name]').addBack('[id],[name]').removeAttr('id').removeAttr('name');
    }
    if (i < batches.length - 1) copy.children('tfoot').remove();
    return $.html(copy);
  });
}
