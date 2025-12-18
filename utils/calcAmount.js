const dayjs = require('dayjs');

function isNight(now, start, end){
  if (start == null || end == null) return false;
  const h = dayjs(now).hour();
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}

function calcAmount(minutes, rp, now = new Date()){
  if (rp.toleranceMin && minutes <= rp.toleranceMin) return 0;
  if (rp.nightFlat && isNight(now, rp.nightStartsAt, rp.nightEndsAt)) return Number(rp.nightFlat);
  let total = Number(rp.base || 0);
  if (rp.perHour) total += Math.ceil(minutes / 60) * Number(rp.perHour);
  else if (rp.per15min) total += Math.ceil(minutes / 15) * Number(rp.per15min);
  return total;
}

module.exports = { calcAmount };
