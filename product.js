/* Product page: loads live Printful variants from the checkout API and starts Stripe Checkout.
   If the API is not configured or unreachable, the page keeps the "Buy on Amazon" button. */
(function () {
  var form = document.getElementById('buy');
  if (!form) return;
  var API = window.DDU_API, slug = form.dataset.slug;
  var state = { variants: [], color: null, size: null };
  var SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', '4XL', '5XL', 'One size'];

  function el(t, a) { var e = document.createElement(t); for (var k in a) e[k] = a[k]; return e; }
  function money(c) { return '$' + (c / 100).toFixed(2); }
  function current() {
    return state.variants.find(function (v) { return v.color === state.color && v.size === state.size; });
  }

  function renderColors() {
    var colors = [], box = document.getElementById('colors');
    state.variants.forEach(function (v) { if (colors.indexOf(v.color) < 0) colors.push(v.color); });
    box.innerHTML = '';
    if (colors.length < 2 && !colors[0]) { state.color = colors[0]; return; }
    document.getElementById('f-color').hidden = false;
    colors.forEach(function (c) {
      var v = state.variants.find(function (x) { return x.color === c; });
      var b = el('button', { type: 'button', title: c });
      b.setAttribute('aria-label', c);
      b.style.background = v.color_code || '#ccc';
      b.onclick = function () { state.color = c; update(); };
      box.appendChild(b);
    });
    if (!state.color) state.color = colors[0];
  }

  function update() {
    document.getElementById('color-name').textContent = state.color || '';
    [].forEach.call(document.querySelectorAll('#colors button'), function (b) {
      b.setAttribute('aria-pressed', b.title === state.color);
    });
    var sizes = state.variants.filter(function (v) { return v.color === state.color; })
      .sort(function (a, b) { return SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size); });
    var sbox = document.getElementById('sizes'); sbox.innerHTML = '';
    if (sizes.length > 1 || (sizes[0] && sizes[0].size)) document.getElementById('f-size').hidden = false;
    if (!sizes.some(function (v) { return v.size === state.size; })) state.size = null;
    sizes.forEach(function (v) {
      var b = el('button', { type: 'button', textContent: v.size || 'One size' });
      b.setAttribute('aria-pressed', v.size === state.size);
      b.onclick = function () { state.size = v.size; update(); };
      sbox.appendChild(b);
    });
    if (sizes.length === 1) state.size = sizes[0].size;
    var v = current();
    if (v) {
      document.getElementById('pp-price').textContent = money(v.price_cents);
      if (v.image) document.getElementById('pp-main').src = v.image;
    }
    document.getElementById('buy-btn').textContent = v ? 'Buy now — ' + money(v.price_cents) : 'Select a size';
  }

  function thumbs(images) {
    var box = document.getElementById('pp-thumbs'), main = document.getElementById('pp-main');
    images.slice(0, 6).forEach(function (src, i) {
      var b = el('button', { type: 'button' });
      b.setAttribute('aria-label', 'Show image ' + (i + 1));
      b.appendChild(el('img', { src: src, alt: '', loading: 'lazy' }));
      b.onclick = function () { main.src = src; };
      box.appendChild(b);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = current(), msg = document.getElementById('buy-msg'), btn = document.getElementById('buy-btn');
    if (!v) { msg.textContent = 'Please choose a size first.'; msg.className = 'hint error'; return; }
    var qty = Math.max(1, Math.min(10, parseInt(document.getElementById('qty').value, 10) || 1));
    btn.disabled = true; btn.textContent = 'Opening secure checkout…';
    fetch(API + '/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: slug, variant_id: v.id, quantity: qty }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.url) { location.href = j.url; return; }
        throw new Error(j.error || 'Checkout unavailable');
      })
      .catch(function () {
        btn.disabled = false; update();
        msg.innerHTML = 'Sorry, checkout is not available right now. Please try again, or use the Amazon link below.';
        msg.className = 'hint error';
      });
  });

  if (!API) return;
  var ctl = new AbortController(); setTimeout(function () { ctl.abort(); }, 6000);
  fetch(API + '/product?slug=' + encodeURIComponent(slug), { signal: ctl.signal })
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (j) {
      if (!j.variants || !j.variants.length) throw 0;
      state.variants = j.variants;
      form.hidden = false;
      document.getElementById('amazon-box').hidden = true;
      document.getElementById('amazon-alt').hidden = false;
      if (j.images && j.images.length) thumbs(j.images);
      renderColors(); update();
    })
    .catch(function () { /* keep the Amazon button */ });
})();
