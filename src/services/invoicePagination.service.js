/**
 * Runs in Chromium and HTML preview after fonts load. Measures complete tbody
 * groups with wrapped text before finalizing their placement on an A4 page.
 * Self contained because the shared HTML template embeds this function.
 */
function paginateInvoice() {
  const invoice = document.querySelector('.invoice');
  const firstPage = invoice.querySelector('.invoice-page');
  const table = firstPage.querySelector('.party-table');
  const groups = Array.from(table.querySelectorAll('.invoice-group'));
  const footer = firstPage.querySelector('.invoice-footer');
  const ruler = document.createElement('div');
  ruler.style.height = '288mm'; // 297mm less @page top (5mm) and bottom (4mm).
  document.body.append(ruler);
  const printableHeight = ruler.getBoundingClientRect().height - 1;
  ruler.remove();

  groups.forEach((group) => group.remove());
  footer.remove();
  const pageTemplate = firstPage.cloneNode(true);
  const pages = [firstPage];
  let current = firstPage;
  const fits = (page) => page.getBoundingClientRect().height <= printableHeight;
  const newPage = () => {
    const page = pageTemplate.cloneNode(true);
    invoice.append(page);
    pages.push(page);
    return page;
  };

  if (!fits(firstPage)) throw new Error('The invoice header is too tall for an A4 page. Please shorten the saved company or transport details.');

  for (const group of groups) {
    current.querySelector('.party-table').append(group);
    if (fits(current)) continue;
    group.remove();
    if (current.querySelector('.invoice-group')) current = newPage();
    current.querySelector('.party-table').append(group);
    if (!fits(current)) {
      const label = group.hasAttribute('data-merge-group') ? 'merged carton group' : 'party row';
      throw new Error(`The ${label} starting at SR. ${group.querySelector('td').textContent} is too tall to fit on one A4 page. Shorten its saved text or reduce the group size before merging; a merged carton cannot be split across pages.`);
    }
  }

  // Keep summary, terms and signatures together, moving the last group with
  // them when possible. There are no filler rows or fixed footer coordinates.
  current.append(footer);
  if (!fits(current)) {
    footer.remove();
    const previous = current;
    const lastGroup = previous.querySelector('.invoice-group:last-child');
    current = newPage();
    if (lastGroup) current.querySelector('.party-table').append(lastGroup);
    current.append(footer);
    if (!fits(current) && lastGroup) {
      // A group can fit by itself but not alongside the whole footer. Preserve
      // it intact, then let the footer flow onto the following page.
      previous.querySelector('.party-table').append(lastGroup);
      current.querySelector('.party-table').remove();
    }
    if (!fits(current)) throw new Error('The invoice summary and signature section are too tall for one A4 page.');
    if (!previous.querySelector('.invoice-group') && groups.length) {
      previous.remove();
      pages.splice(pages.indexOf(previous), 1);
    }
  }

  pages.forEach((page, index) => { page.dataset.pageNumber = String(index + 1); });
  invoice.dataset.paginated = 'true';
  return { pageCount: pages.length };
}

module.exports = { paginateInvoice };
