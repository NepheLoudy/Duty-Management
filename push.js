/**
 * 统一部署脚本：一条命令完成「代码进 Git + 配置进 NAS + 部署」
 * （复制 approval-bot 版，按 qianli-deploy 链路改四处：TAR_NAME / REMOTE_DIR / GIT_REMOTE / PM2_NAME）
 *
 * 用法：
 *   npm run push "提交说明"   提交并部署
 *   npm run push              使用默认提交说明 "update: 代码更新"
 *
 * 流程：
 *   [1/4] 代码提交推送到 GitHub（失败则标记，稍后改走 SFTP 直传）
 *   [2/4] 部署代码到 NAS（git push 成功走 git fetch，失败走 SFTP 打包直传）
 *   [3/4] 上传 .env 与真实名册/白名单到 NAS（含飞书密钥与成员信息，只单独进 NAS，绝不进 git）
 *   [4/4] npm install + 重启服务
 *
 * NAS 连接配置从 .env 读取（NAS_HOST/NAS_PORT/NAS_USER/NAS_PASSWORD），脚本不存任何密钥。
 */
const { spawnSync } = require('child_process');
const { Client } = require('ssh2');
const os = require('os');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const commitMessage = process.argv[2] || 'update: 代码更新';
const TAR_NAME = 'duty-bot-deploy.tar.gz';
// 打包时用相对文件名 + cwd 指向临时目录，避免 Windows GNU tar 把 "C:" 当远程主机
const TAR_LOCAL = path.join(os.tmpdir(), TAR_NAME);
const TAR_REMOTE = '/tmp/' + TAR_NAME;
const REMOTE_DIR = '/opt/duty-bot';
const GIT_REMOTE = 'https://github.com/NepheLoudy/Duty-Management.git';
const PM2_NAME = 'duty-bot';

// 真实名册/白名单在 .gitignore 里（含成员姓名与 open_id，绝不进 git），
// 但 NAS 运行必须有：走 git 路径部署时仓库里没有这两个文件，这里显式 SFTP 补齐。
// 【运行时数据保护】这两份文件的权威编辑路径在 NAS 侧（运维台/定制窗口），本地只是种子：
// 上传前先备份 NAS 现网版本；本地条目数少于现网时跳过上传（PUSH_FORCE_PRIVATE=1 强制覆盖）。
// 事故记录：2026-09-12 v9 推送曾用本地空 whitelist.json 覆盖 NAS 18 人排除名单（不可恢复）。
const PRIVATE_CONFIG_FILES = ['config/members.json', 'config/whitelist.json'];
const DATA_DIR = '/home/qianli/duty-bot-data';

/** 估算配置里的条目数（数组字段长度求和；解析失败按内容字节数/100 估） */
function countEntries(content) {
  if (!content || !content.trim()) return 0;
  try {
    const obj = JSON.parse(content);
    const arrays = Object.values(obj).filter((v) => Array.isArray(v));
    if (arrays.length) return arrays.reduce((sum, a) => sum + a.length, 0);
    return Object.keys(obj).length;
  } catch {
    return Math.floor(content.length / 100);
  }
}

const nasConfig = {
  host: process.env.NAS_HOST,
  port: Number(process.env.NAS_PORT || 22),
  username: process.env.NAS_USER,
  password: process.env.NAS_PASSWORD,
};
if (!nasConfig.host || !nasConfig.password) {
  console.error('缺少 NAS 部署配置：请在 .env 中配置 NAS_HOST/NAS_PORT/NAS_USER/NAS_PASSWORD');
  process.exit(1);
}

// ============ [1/4] 代码提交推送到 GitHub ============
console.log('========== [1/4] 代码提交推送到 GitHub ==========');

const add = spawnSync('git', ['add', '-A'], { stdio: 'inherit' });
if (add.status !== 0) {
  console.error('git add 失败');
  process.exit(1);
}

const hasChanges = spawnSync('git', ['diff', '--cached', '--quiet']).status !== 0;
if (hasChanges) {
  const commit = spawnSync('git', ['commit', '-m', commitMessage], { stdio: 'inherit' });
  if (commit.status !== 0) {
    console.error('git commit 失败');
    process.exit(1);
  }
} else {
  console.log('(无待提交改动，跳过 commit)');
}

const push = spawnSync('git', ['push'], { stdio: 'inherit' });
const gitPushed = push.status === 0;
if (gitPushed) {
  console.log('✓ git push 成功，NAS 将通过 git fetch 拉取代码');
} else {
  console.log('⚠ git push 失败（本地无法访问 GitHub 443 或远端未建仓），改用 SFTP 直传代码到 NAS');
}

// ============ 连接 NAS ============
console.log('\n========== [2/4] 连接 NAS 部署代码 ==========');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH 连接成功');
  deployCode().catch((err) => { console.error('部署失败:', err.message); conn.end(); process.exit(1); });
});

// 执行命令并返回退出码（不中断流程，便于降级处理）
function execCode(cmd) {
  return new Promise((resolve) => {
    console.log('>', cmd);
    conn.exec(cmd, (err, stream) => {
      if (err) { console.error('执行失败:', err.message); resolve(-1); return; }
      stream.on('data', (d) => process.stdout.write(d.toString()));
      stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
      stream.on('close', (code) => resolve(code));
    });
  });
}

conn.on('error', (err) => {
  console.error('SSH 连接失败:', err.message);
  process.exit(1);
});

// 执行单条命令（成功回调 cb）
function exec(cmd, cb) {
  console.log('>', cmd);
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('执行失败:', err.message);
      conn.end();
      process.exit(1);
    }
    stream.on('data', (d) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
    stream.on('close', (code) => {
      if (code !== 0) {
        console.error(`命令失败 (退出码 ${code})`);
        conn.end();
        process.exit(code);
      }
      cb();
    });
  });
}

// 部署代码（git 或 SFTP 两种方式）
async function deployCode() {
  if (gitPushed) {
    const cmd = 'mkdir -p ' + REMOTE_DIR + ' && cd ' + REMOTE_DIR + ' && '
      + 'if [ ! -d .git ]; then git init; fi; '
      + 'git remote set-url origin ' + GIT_REMOTE + ' 2>/dev/null || git remote add origin ' + GIT_REMOTE + '; '
      + 'git fetch origin main && git reset --hard origin/main';
    const code = await execCode(cmd);
    if (code === 0) return npmInstall();
    console.log('⚠ NAS 拉取 GitHub 失败（NAS 网络不通），改用 SFTP 直传代码');
  }
  {
    console.log('本地打包代码...');
    const pack = spawnSync('tar', [
      '-czf', TAR_NAME,
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=.env',
      '--exclude=.duty-state.json',
      '--exclude=.quiet-backlog.json',
      '--exclude=logs',
      '--exclude=*.log',
      '--exclude=' + TAR_NAME,
      '-C', __dirname,
      '.',
    ], { stdio: 'inherit', cwd: os.tmpdir() });
    if (pack.status !== 0) {
      console.error('打包失败');
      conn.end();
      process.exit(1);
    }

    conn.sftp((err, sftp) => {
      if (err) {
        console.error('SFTP 失败:', err.message);
        conn.end();
        process.exit(1);
      }
      console.log('上传代码包到 NAS...');
      sftp.fastPut(TAR_LOCAL, TAR_REMOTE, (err2) => {
        if (err2) {
          console.error('代码上传失败:', err2.message);
          conn.end();
          process.exit(1);
        }
        console.log('✓ 代码包已上传');
        const cmd = 'mkdir -p ' + REMOTE_DIR + ' && rm -rf ' + REMOTE_DIR + '/.git ' + REMOTE_DIR + '/* ' + REMOTE_DIR + '/.[!.]* 2>/dev/null || true; '
          + 'tar -xzf ' + TAR_REMOTE + ' -C ' + REMOTE_DIR;
        exec(cmd, () => npmInstall());
      });
    });
  }
}

// npm install
function npmInstall() {
  console.log('\n安装依赖...');
  exec('cd ' + REMOTE_DIR + ' && npm install --production', () => uploadEnv());
}

// ============ [3/4] 上传 .env 与私有配置 ============
function uploadEnv() {
  console.log('\n========== [3/4] 上传 .env 与真实名册/白名单到 NAS ==========');
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP 失败:', err.message);
      conn.end();
      process.exit(1);
    }
    const envFile = '.env';
    const privateFiles = PRIVATE_CONFIG_FILES.filter((f) => fs.existsSync(path.join(__dirname, f)));
    const uploadNext = (i) => {
      if (i >= privateFiles.length) {
        console.log('✓ 配置已上传到 NAS（含飞书密钥与成员信息，仅存于 NAS，不进 git）');
        return restart();
      }
      const f = privateFiles[i];
      return guardUploadPrivate(sftp, f, () => uploadNext(i + 1));
    };
    // .env 是部署源头，直接传
    exec('true', () => {
      sftp.fastPut(path.join(__dirname, envFile), REMOTE_DIR + '/' + envFile, (err2) => {
        if (err2) {
          console.error('.env 上传失败:', err2.message);
          conn.end();
          process.exit(1);
        }
        console.log('✓ .env 已上传');
        uploadNext(0);
      });
    });
  });
}

// 私有配置保护上传：①NAS 现网有内容且与本地不同 → 先备份到项目外数据目录；
// ②本地条目数少于现网 → 视为种子过期，跳过上传（PUSH_FORCE_PRIVATE=1 才覆盖）
function guardUploadPrivate(sftp, f, done) {
  const remotePath = REMOTE_DIR + '/' + f;
  sftp.readFile(remotePath, 'utf8', (err, remoteContent) => {
    const localContent = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const remoteCount = err ? 0 : countEntries(remoteContent);
    const localCount = countEntries(localContent);

    const proceed = () => {
      const mkdirCmd = 'mkdir -p ' + REMOTE_DIR + '/' + path.dirname(f);
      return exec(mkdirCmd, () => {
        sftp.fastPut(path.join(__dirname, f), remotePath, (err2) => {
          if (err2) {
            console.error(`${f} 上传失败:`, err2.message);
            conn.end();
            process.exit(1);
          }
          console.log(`✓ ${f} 已上传`);
          done();
        });
      });
    };

    const backupThen = (next) => {
      if (err || !remoteContent.trim() || remoteContent === localContent) return next();
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = DATA_DIR + '/backup/' + f.replace(/\//g, '_') + '.' + ts + '.bak';
      return exec('mkdir -p ' + DATA_DIR + '/backup', () => {
        sftp.writeFile(backupPath, remoteContent, (err3) => {
          if (err3) console.warn(`⚠ ${f} 现网备份失败（继续上传）:`, err3.message);
          else console.log(`✓ ${f} 现网版本已备份: ${backupPath}`);
          next();
        });
      });
    };

    if (remoteCount > localCount && process.env.PUSH_FORCE_PRIVATE !== '1') {
      console.warn(`⚠ [私有配置保护] 跳过 ${f} 上传：本地 ${localCount} 条 < NAS 现网 ${remoteCount} 条（本地种子过期，权威在 NAS 侧）。`);
      console.warn('  确认要用本地覆盖请设 PUSH_FORCE_PRIVATE=1 重跑；NAS 现网内容已回填本地以防丢失。');
      // 把现网内容回写本地，消除种子与现网的落差（下次不再触发守卫）
      fs.writeFileSync(path.join(__dirname, f), remoteContent);
      return done();
    }
    backupThen(proceed);
  });
}

// ============ [4/4] 重启服务 ============
function restart() {
  console.log('\n========== [4/4] 重启服务 ==========');
  const cmd = 'pm2 restart ' + PM2_NAME + ' --update-env 2>/dev/null || pm2 start ' + REMOTE_DIR + '/src/index.js --name ' + PM2_NAME + '; pm2 save';
  exec(cmd, () => {
    console.log('\n✅ 部署完成，服务状态：');
    conn.exec('pm2 list', (err, stream) => {
      if (err) { conn.end(); return; }
      stream.on('data', (d) => process.stdout.write(d.toString()));
      stream.on('close', () => conn.end());
    });
  });
}

console.log('正在连接 NAS...');
conn.connect(nasConfig);
