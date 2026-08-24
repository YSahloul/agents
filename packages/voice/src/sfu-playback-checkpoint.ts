export interface SFUPlaybackCheckpoint {
  id: string;
  text: string;
}

export interface SFUPlaybackCheckpointState {
  acknowledged?: SFUPlaybackCheckpoint;
}

export function acknowledgeSFUPlaybackCheckpoint(
  checkpoint: SFUPlaybackCheckpoint
): SFUPlaybackCheckpointState {
  return { acknowledged: checkpoint };
}
