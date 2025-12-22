const dayjs = require('dayjs');

function isNight(now, start, end){
  if (start == null || end == null) return false;
  const h = dayjs(now).hour();
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}

function calcAmount(minutes, rp, now = new Date()){
  const tol = Number(rp?.toleranceMin || 0) || 0;
  if (tol > 0 && minutes <= tol) return 0;

  if (rp?.nightFlat && isNight(now, rp?.nightStartsAt, rp?.nightEndsAt)) {
    return Number(rp.nightFlat);
  }

  let total = Number(rp?.base || 0);

  if (rp?.perHour != null) {
    total += Math.ceil(minutes / 60) * Number(rp.perHour);
  } else if (rp?.per30min != null) {
    total += Math.ceil(minutes / 30) * Number(rp.per30min);
  } else if (rp?.per15min != null) {
    total += Math.ceil(minutes / 15) * Number(rp.per15min);
  }

  return total;
}

module.exports = { calcAmount };
