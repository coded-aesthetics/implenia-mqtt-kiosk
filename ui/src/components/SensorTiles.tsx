import type { CSSProperties } from 'react';

/**
 * The value tiles that fill the Messwerte and Vorgabe tabs.
 *
 * ElementDetail rendered six of these blocks inline — hero/primary/secondary,
 * once for live readings and once for vorgaben — each an identical map over a
 * list, differing only in which style keys it reached for. The shape is one
 * component now, and the six looks are a table.
 *
 * The styles are carried over unchanged: this is the screen a worker watches
 * while drilling, and a refactor is the wrong moment to restyle it.
 */

export type TilePriority = 'hero' | 'primary' | 'secondary';

/** Live readings and vorgaben are visually distinct on purpose. */
export type TileVariant = 'live' | 'vorgabe';

export interface TileItem {
  /** React key — the topic for a reading, the sensor name for a vorgabe. */
  key: string;
  label: string;
  value: string;
  unit?: string;
}

/** Which style keys each variant/priority combination uses. */
const LOOKS: Record<TileVariant, Record<TilePriority, {
  tile: string; label: string; value: string; unit: string;
}>> = {
  live: {
    hero: { tile: 'heroTile', label: 'heroLabel', value: 'heroValue', unit: 'heroUnit' },
    primary: { tile: 'primaryTile', label: 'tileLabel', value: 'primaryValue', unit: 'unit' },
    secondary: { tile: 'secondaryTile', label: 'secondaryLabel', value: 'secondaryValue', unit: 'secondaryUnit' },
  },
  vorgabe: {
    hero: { tile: 'heroVorgabeTile', label: 'heroLabel', value: 'heroVorgabeValue', unit: 'heroUnit' },
    primary: { tile: 'vorgabeTile', label: 'tileLabel', value: 'tileValue', unit: 'tileUnit' },
    secondary: { tile: 'secondaryVorgabeTile', label: 'secondaryLabel', value: 'secondaryVorgabeValue', unit: 'secondaryUnit' },
  },
};

const GRIDS: Record<TilePriority, string> = {
  hero: 'heroGrid',
  primary: 'primaryGrid',
  secondary: 'secondaryGrid',
};

interface Props {
  items: TileItem[];
  priority: TilePriority;
  variant: TileVariant;
}

/** One grid of tiles. Renders nothing when there is nothing to show. */
export function TileGrid({ items, priority, variant }: Props) {
  if (items.length === 0) return null;
  const look = LOOKS[variant][priority];

  return (
    <div style={styles[GRIDS[priority]]}>
      {items.map((item) => (
        <div key={item.key} style={styles[look.tile]}>
          <div style={styles[look.label]}>{item.label}</div>
          <div style={styles[look.value]}>
            {item.value}
            {item.unit && <span style={styles[look.unit]}>{item.unit}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  heroGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '0.5rem',
    marginBottom: '0.5rem',
  },
  primaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '0.5rem',
    marginBottom: '0.5rem',
  },
  secondaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: '0.5rem',
    marginBottom: '1rem',
  },
  heroTile: {
    backgroundColor: '#16213e',
    borderRadius: '12px',
    padding: '0.75rem 1.5rem',
    minHeight: '64px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    border: '1px solid #1976d2',
  },
  heroVorgabeTile: {
    backgroundColor: '#1a2744',
    borderRadius: '12px',
    padding: '1.25rem 1.5rem',
    minHeight: '100px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    borderLeft: '4px solid #1976d2',
  },
  primaryTile: {
    backgroundColor: '#16213e',
    borderRadius: '10px',
    padding: '0.6rem 1.25rem',
    minHeight: '64px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
  },
  vorgabeTile: {
    backgroundColor: '#1a2744',
    borderRadius: '10px',
    padding: '1rem 1.25rem',
    borderLeft: '4px solid #1976d2',
    minHeight: '64px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
  },
  secondaryTile: {
    backgroundColor: '#111d33',
    borderRadius: '8px',
    padding: '0.6rem 0.8rem',
    minHeight: '50px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.85,
  },
  secondaryVorgabeTile: {
    backgroundColor: '#151f36',
    borderRadius: '8px',
    padding: '0.6rem 0.8rem',
    minHeight: '50px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    borderLeft: '3px solid #2a3f5f',
    opacity: 0.85,
  },
  heroLabel: {
    fontSize: '0.9rem',
    color: '#8899aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: '0.3rem',
    fontWeight: 600,
  },
  tileLabel: {
    fontSize: '0.85rem',
    color: '#8899aa',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginBottom: '0.3rem',
  },
  secondaryLabel: {
    fontSize: '0.7rem',
    color: '#667788',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginBottom: '0.15rem',
  },
  heroValue: {
    fontSize: '3.5rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.1,
  },
  heroVorgabeValue: {
    fontSize: '3rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.1,
  },
  primaryValue: {
    fontSize: '2rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.2,
  },
  tileValue: {
    fontSize: '1.6rem',
    fontWeight: 700,
    color: '#ffffff',
  },
  secondaryValue: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#ccddee',
    lineHeight: 1.2,
  },
  secondaryVorgabeValue: {
    fontSize: '1.3rem',
    fontWeight: 700,
    color: '#ccddee',
  },
  heroUnit: {
    fontSize: '1.5rem',
    fontWeight: 400,
    color: '#8899aa',
    marginLeft: '0.3rem',
  },
  unit: {
    fontSize: '1rem',
    fontWeight: 400,
    color: '#8899aa',
    marginLeft: '0.25rem',
  },
  tileUnit: {
    fontSize: '1rem',
    fontWeight: 400,
    color: '#8899aa',
    marginLeft: '0.25rem',
  },
  secondaryUnit: {
    fontSize: '0.75rem',
    fontWeight: 400,
    color: '#667788',
    marginLeft: '0.2rem',
  },
};
