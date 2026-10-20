import type { ConfigState } from '../hooks/useImplenia';
import type { DeviceFrame } from '../hooks/useWebSocket';
import { ConfigHub } from './ConfigHub';
import { NetzwerkConfig } from './NetzwerkConfig';
import { VerbindungConfig } from './VerbindungConfig';
import { DatenquelleConfig } from './DatenquelleConfig';
import { MesswerteConfig } from './MesswerteConfig';
import { DatenuebertragungConfig } from './DatenuebertragungConfig';
import { SystemConfig } from './SystemConfig';

interface Props {
  config: ConfigState;
  devMode: boolean;
  deviceFrames: Map<number, DeviceFrame>;
  updateAvailable: string | null;
  section?: string;
}

const VALID_SECTIONS = [
  'netzwerk', 'verbindung', 'datenquelle', 'messwerte', 'datenuebertragung', 'system',
] as const;
type Section = typeof VALID_SECTIONS[number];

function isSection(v: string): v is Section {
  return (VALID_SECTIONS as readonly string[]).includes(v);
}

export function ConfigPage({ config, devMode, deviceFrames, updateAvailable, section }: Props) {
  if (!section || !isSection(section)) {
    return <ConfigHub config={config} updateAvailable={updateAvailable} />;
  }
  switch (section) {
    case 'netzwerk':
      return <NetzwerkConfig />;
    case 'verbindung':
      return <VerbindungConfig config={config} />;
    case 'datenquelle':
      return <DatenquelleConfig devMode={devMode} deviceFrames={deviceFrames} />;
    case 'messwerte':
      return <MesswerteConfig />;
    case 'datenuebertragung':
      return <DatenuebertragungConfig />;
    case 'system':
      return <SystemConfig />;
  }
}
