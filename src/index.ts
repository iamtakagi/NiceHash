process.env.TZ = "Asia/Tokyo";

// 参照: https://github.com/discordjs/RPC/blob/master/example/main.js

import moment from "moment";
import "moment/locale/ja";
import electron, { app, BrowserWindow } from "electron";
import { Config, loadConfig } from "./config";
import {
  DISCORD_RICH_PRESENCE_LARGE_IMAGE_TEXT,
  DISCORD_RPC_CLIENT_ID,
  NICEHASH_LOGO_URL,
  NICEHASH_SITE_URL,
} from "./constants";
import { getRigs, NicehashRigs } from "./nicehashApi";
import { RPC } from "./rpcLoader";

let mainWindow: BrowserWindow | undefined;
let rpc: RPC.Client | undefined;
let startTimestamp: number;
let config: Config | undefined;
let rigs: NicehashRigs.RootObject | undefined;
let gpuDecvice: NicehashRigs.Device | undefined;

async function init() {
  // Config 読み込み
  config = await loadConfig();

  // Config 値チェック
  if(!config.nicehash["apiKey"] || !config.nicehash["apiSecret"] || !config.nicehash["orgId"] || !config["gpuDeviceBrand"]) {
    electron.dialog.showErrorBox("エラー", "NiceHash API Key 等を config.json に記述してください")
    return process.exit(0)
  }

  // Rigs 初期取得
  rigs = await getRigs(config["nicehash"]);

  // GPU Device 初期取得
  gpuDecvice = await getGpuDevice(rigs, config["gpuDeviceBrand"]);

  // Rigs 1分毎に取得するタスク
  setInterval(async () => {
    if (!config) return;

    // Rigs 取得
    rigs = await getRigs(config["nicehash"]);

    // GPU Device 取得
    gpuDecvice = await getGpuDevice(rigs, config["gpuDeviceBrand"]);
  }, 1000 * 30);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    webPreferences: {
      nodeIntegration: true,
    },
  });
  mainWindow.setTitle("NiceHash");
  mainWindow.loadURL(NICEHASH_SITE_URL);

  mainWindow.once("ready-to-show", () => {
    const i = setInterval(async () => {
      await init();
      rpc = new RPC.Client({ transport: "ipc" });
      RPC.register(DISCORD_RPC_CLIENT_ID);

      rpc.on("ready", () => {
        startTimestamp = Date.now();
        setActivity();
        setInterval(() => {
          setActivity();
        }, 1000);
      });

      rpc.login({ clientId: DISCORD_RPC_CLIENT_ID }).catch(console.error);
      clearInterval(i);
    }, 1000);
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

app.on("ready", () => {
  createMainWindow();
});

app.on("window-all-closed", () => {
  if (rpc) {
    rpc.destroy();
  }
  app.quit();
});

app.on("activate", () => {
  if (!mainWindow) {
    createMainWindow();
  }
});

async function getGpuDevice(rigs: NicehashRigs.RootObject, gpuDeviceBrand: Config["gpuDeviceBrand"]) {
  const gpuDevice = await new Promise<NicehashRigs.Device>((resolve) =>
    rigs.miningRigs.map((rig) => {
      resolve(
        rig.devices.filter(
          (device) =>
            device.deviceType.enumName === gpuDeviceBrand &&
            device.status.enumName !== "DISABLED"
        )[0]
      );
    })
  );

  return gpuDevice;
}

async function setActivity() {
  if (!rpc || !mainWindow || !rigs || !gpuDecvice) return;

  const { name, status, speeds, powerUsage, intensity } = gpuDecvice;

  if (status.enumName !== "MINING")
    return rpc.setActivity({
      details: `${name}`,
      state: `${status.description}`,
      startTimestamp,
      largeImageKey: NICEHASH_LOGO_URL,
      largeImageText: DISCORD_RICH_PRESENCE_LARGE_IMAGE_TEXT,
      instance: false,
    });

  // 参照: https://qiita.com/sugasaki/items/a24580f3f3fd33990cbf
  const goal = moment(new Date(rigs.nextPayoutTimestamp).getTime());
  const start = moment();

  let duration = moment.duration(goal.diff(start), "milliseconds"); //差分をミリ秒で取得し、ミリ秒→durationへ変換

  // 参照: https://zenn.dev/captain_blue/articles/zero-padding-in-javascript
  const nextPayout =
    duration.hours().toString().padStart(2, "0") +
    ":" +
    duration.minutes().toString().padStart(2, "0") +
    ":" +
    duration.seconds().toString().padStart(2, "0");

  // https://zenn.dev/katoaki/articles/d9646053e3ff2f
  rpc.setActivity({
    details: `${name} (${
      (speeds[0]
        ? Number(speeds[0].speed).toFixed(2) +
          " " +
          speeds[0].displaySuffix +
          "/s)"
        : 0) + ` ${powerUsage}W (${intensity.description})`
    }`,
    state: `次回のお支払い ${nextPayout} / 未払いマイニング報酬: ${rigs.unpaidAmount} BTC`,
    startTimestamp,
    largeImageKey: NICEHASH_LOGO_URL,
    largeImageText: DISCORD_RICH_PRESENCE_LARGE_IMAGE_TEXT,
    instance: false,
  });
}
