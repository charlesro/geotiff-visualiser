import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { BARE } from '../simulate';

/**
 * The season every species records, and what one mixed pixel records, as lines
 * over the year. A file of its own so that step 3 can fetch it, and the
 * charting library with it, only when the fold is opened (see SimStep).
 */
export default function SeasonChart({ series, lines, colors, names, noise }: {
  /** One row per day sampled: `s{i}` per species, `soil`, `mix`, and the noise band `lo`/`hi` (use-simulation `ndviSeries`). */
  series: Record<string, number>[];
  /** One entry per distinct growth curve: the first species on it, and how many share it. */
  lines: { i: number; n: number }[];
  colors: string[];
  names: string[];
  /** Whether the noise band is drawn. */
  noise: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={series} margin={{ top: 5, right: 6, bottom: 0, left: -24 }}>
        <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#888' }} ticks={[0, 90, 180, 270, 365]} />
        <YAxis domain={[0, 1]} tick={{ fontSize: 12, fill: '#888' }} />
        <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 13 }} labelFormatter={d => `day ${d}`} />
        {noise && <Line type="monotone" dataKey="hi" stroke="#64748b" dot={false} strokeWidth={0.75} name="noise +σ" />}
        {noise && <Line type="monotone" dataKey="lo" stroke="#64748b" dot={false} strokeWidth={0.75} name="noise −σ" />}
        {/* One line per species. Two hardcoded series plotted
            maize and wheat for a four-species trial and simply
            omitted the rest, with nothing to show it had. */}
        {lines.map(({ i, n }) => (
          <Line key={i} type="monotone" dataKey={`s${i}`} stroke={colors[i]}
            dot={false} strokeWidth={1.5} name={n > 1 ? `${names[i]} and ${n - 1} more` : names[i]} />
        ))}
        {/* Bare soil drawn like a crop: its own season, flat because
            soil has no phenology. It is a real part of every pixel
            that touches an alley, and the mixed curve weights it in. */}
        <Line type="monotone" dataKey="soil" stroke={BARE.color} dot={false} strokeWidth={1.5} name="Bare soil" />
        <Line type="monotone" dataKey="mix" stroke="#e5e7eb" strokeDasharray="4 3" dot={false} strokeWidth={1.5} name="Mixed pixel" />
      </LineChart>
    </ResponsiveContainer>
  );
}
