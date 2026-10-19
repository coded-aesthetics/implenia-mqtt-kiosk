import { UpdateUpload } from './UpdateUpload';
import { VoiceCard } from './VoiceCard';
import { FernwartungCard } from './FernwartungCard';
import { ResetCard } from './ResetCard';
import { configStyles as styles } from './configStyles';

export function SystemConfig() {
  return (
    <div style={styles.container}>
      <UpdateUpload />
      <VoiceCard />
      {/*
        Fernwartung fills the grid's fourth slot beside the reset card, so the
        screen gains a card without gaining a row — the config screens have no
        scrollbar to warn anybody when they overflow 768px.
      */}
      <FernwartungCard />
      <ResetCard />
    </div>
  );
}
