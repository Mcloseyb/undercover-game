// Keep the active input and scroller attached while room updates arrive.
// Replacing the input on each update blurs the mobile keyboard and interrupts IME.
export function updateView(app, markup) {
  const template = app.ownerDocument.createElement('template');
  template.innerHTML = markup;
  const next = template.content.querySelector('.game-layout');
  const current = app.querySelector('.game-layout');
  if (!next || !current) {
    app.replaceChildren(template.content);
    return;
  }
  current.className = next.className;
  const key = element => element.id || element.className;
  const wanted = new Set([...next.children].map(key));
  for (const element of [...current.children]) if (!wanted.has(key(element))) element.remove();
  for (const element of [...next.children]) {
    const existing = [...current.children].find(child => key(child) === key(element));
    if (!existing) { current.append(element); continue; }
    if (element.id === 'game-scroll') {
      if (existing.innerHTML !== element.innerHTML) existing.innerHTML = element.innerHTML;
    } else if (element.id === 'composer-area') {
      const input = existing.querySelector('input');
      const newInput = element.querySelector('input');
      input.disabled = newInput.disabled;
      input.placeholder = newInput.placeholder;
      if (input.dataset.composing !== 'true' && input.value !== newInput.value) input.value = newInput.value;
      const button = existing.querySelector('button');
      const nextButton = element.querySelector('button');
      button.disabled = nextButton.disabled;
      button.textContent = nextButton.textContent;
      existing.querySelector('.composer-help').innerHTML = element.querySelector('.composer-help').innerHTML;
    } else if (existing.outerHTML !== element.outerHTML) existing.replaceWith(element);
  }
}
