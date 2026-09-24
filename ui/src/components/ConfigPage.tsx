import type { ConfigState } from '../hooks/useImplenia';
import type { DeviceFrame } from '../hooks/useWebSocket';
import { ConfigHub } from './ConfigHub';
import { VerbindungConfig } from './VerbindungConfig';
import { DatenquelleConfig } from './DatenquelleConfig';
import { MesswerteConfig } from './MesswerteConfig';
import { SystemConfig } from './SystemConfig';

interface Props {
  config: ConfigState;
  devMode: boolean;
  deviceFrames: Map<number, DeviceFrame>;
  updateAvailable: string | null;
  section?: string;
}

const VALID_SECTIONS = ['verbindung', 'datenquelle', 'messwerte', 'system'] as const;
type Section = typeof VALID_SECTIONS[number];

function isSection(v: string): v is Section {
  return (VALID_SECTIONS as readonly string[]).includes(v);
}

export function ConfigPage({ config, devMode, deviceFrames, updateAvailable, section }: Props) {
  if (!section || !isSection(section)) {
    return <ConfigHub config={config} updateAvailable={updateAvailable} />;
  }
  switch (section) {
    case 'verbindung':
      return <VerbindungConfig config={config} devMode={devMode} />;
    case 'datenquelle':
      return <DatenquelleConfig devMode={devMode} deviceFrames={deviceFrames} />;
    case 'messwerte':
      return <MesswerteConfig />;
    case 'system':
      return <SystemConfig />;
  }
}
