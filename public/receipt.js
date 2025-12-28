const API_BASE = location.origin + '/public';
const params = new URLSearchParams(location.search);
const code = params.get('code');

const $ = (id) => document.getElementById(id);
const fmtARS = new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 });

async function load() {
  if (!code) { alert('Falta el código (?code=...)'); return; }
  try {
    const res = await fetch(`${API_BASE}/tickets/${encodeURIComponent(code)}/summary`, { cache: 'no-store' });
    if (!res.ok) throw new Error('No se pudo obtener el ticket');
    const data = await res.json();

    $('parkingName').textContent = data.parking?.name || 'Estacionamiento';

    const metaParts = [];
    if (data.parking?.direction) metaParts.push(String(data.parking.direction));
    if (data.parking?.phone) metaParts.push(`Tel: ${data.parking.phone}`);
    $('parkingMeta').textContent = metaParts.length ? metaParts.join(' · ') : 'Comprobante de Ingreso (vista pública)';
    $('entryCode').textContent   = data.ticket.entryCode || code;
    $('plate').textContent       = data.ticket.plate;
    $('vehicleType').textContent = data.ticket.vehicleType;
    $('checkInAt').textContent   = new Date(data.ticket.checkInAt).toLocaleString();
    $('minutes').textContent     = `${data.live.minutes} min`;

    const currency = data.rateplan.currency || 'ARS';
    const amount   = Number(data.live.amount || 0);
    $('amount').textContent = currency==='ARS' ? fmtARS.format(amount) : `${amount.toFixed(0)} ${currency}`;
    $('updatedAt').textContent = `Actualizado: ${new Date(data.live.at).toLocaleTimeString()}`;

    const rules = [];
    if (data.rateplan.perHour    != null) rules.push(`Por hora: ${fmtARS.format(Number(data.rateplan.perHour||0))}`);
    if (data.rateplan.per30min   != null) rules.push(`Cada 30': ${fmtARS.format(Number(data.rateplan.per30min||0))}`);
    if (data.rateplan.toleranceMin)       rules.push(`Tolerancia: ${data.rateplan.toleranceMin} min`);
    if (data.rateplan.nightFlat) {
      const s = data.rateplan.nightStartsAt!=null ? data.rateplan.nightStartsAt + ':00' : '';
      const e = data.rateplan.nightEndsAt  !=null ? data.rateplan.nightEndsAt   + ':00' : '';
      rules.push(`Noche: ${fmtARS.format(Number(data.rateplan.nightFlat||0))} ${s&&e?`(de ${s} a ${e})`:''}`);
    }
    $('rules').innerHTML = rules.map(r=>`<li>${r}</li>`).join('');

    const shareText = encodeURIComponent(
      `${data.parking?.name || 'Estacionamiento'} - Ticket #${data.ticket.id}\n` +
      `Patente: ${data.ticket.plate}\n` +
      `Ingreso: ${new Date(data.ticket.checkInAt).toLocaleString()}\n` +
      `Importe estimado: ${currency==='ARS'?fmtARS.format(amount):(amount+' '+currency)}\n` +
      `Código: ${data.ticket.entryCode}`
    );
    const pageUrl = location.href;
    $('btnShare').href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}`;
    $('btnWhats').href = `https://wa.me/?text=${shareText}%0A${encodeURIComponent(pageUrl)}`;

    const qrImg = $('qrImg');
    if (qrImg) {
      qrImg.src = `${API_BASE}/tickets/${encodeURIComponent(code)}/qr?ts=${Date.now()}`;
    }

  } catch (e) {
    alert(e.message || e);
  }
}

load();
setInterval(load, 15000);
