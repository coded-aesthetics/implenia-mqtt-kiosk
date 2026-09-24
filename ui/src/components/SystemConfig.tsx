import { UpdateUpload } from './UpdateUpload';
import { VoiceCard } from './VoiceCard';
import { ResetCard } from './ResetCard';
import { configStyles as styles } from './configStyles';

export function SystemConfig() {
  return (
    <div style={styles.container}>
      <UpdateUpload />
      <VoiceCard />
      <ResetCard />
    </div>
  );
}
