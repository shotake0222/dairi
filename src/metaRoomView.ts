/**
 * 部屋に入った人へ渡す「エリアの見え方」を組み立てる。
 *
 *   エリアの設定（metaverse.ts）＋ 止めたミニゲームを抜く（publicRoom）
 *   ＋ NPC（adminCharacters.ts）＋ 区画に置いた広告・ランドマーク（land.ts）＋ 販売中の目印
 */

import { roomNpcs, type AdminCharacterEnv } from "./adminCharacters";
import { getLandSettings, roomPlacements, roomPlotsForSale } from "./land";
import { getGameSettings, publicRoom, type RoomConfig } from "./metaverse";

export async function roomView(env: AdminCharacterEnv, room: RoomConfig): Promise<RoomConfig> {
  const [settings, land] = await Promise.all([getGameSettings(env), getLandSettings(env)]);
  const base = publicRoom(room, settings);
  const [npcs, placements, plotsForSale] = await Promise.all([
    roomNpcs(env, room.id).catch(() => []),
    roomPlacements(env, room.id).catch(() => []),
    roomPlotsForSale(env, room.id, land).catch(() => []),
  ]);
  return {
    ...base,
    npcs: npcs as unknown as RoomConfig["npcs"],
    placements: placements as unknown as RoomConfig["placements"],
    plotsForSale: plotsForSale as unknown as RoomConfig["plotsForSale"],
  };
}
