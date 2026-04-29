const fs = require('fs');
const path = require('path');

const patches = [
  {
    file: path.join(__dirname, '..', 'node_modules', '@chat21', 'chat21-node-sdk', 'src', 'chat21.js'),
    replacements: [
      ["config.authorization = 'Bearer ' + config.token;", "config.authorization = config.token;"],
      ['config.authorization = "Bearer " + config.token;', 'config.authorization = config.token;'],
    ],
  },
  {
    file: path.join(__dirname, '..', 'node_modules', '@chat21', 'chat21-node-sdk', 'src', 'auth.js'),
    replacements: [
      ["config.authorization = 'Bearer ' + token;", "config.authorization = token;"],
      ['config.authorization = "Bearer " + token;', 'config.authorization = token;'],
      ["config.authorization = 'Bearer ' + admintoken;", "config.authorization = admintoken;"],
      ['config.authorization = "Bearer " + admintoken;', 'config.authorization = admintoken;'],
    ],
  },
];

for (const patch of patches) {
  if (!fs.existsSync(patch.file)) {
    console.warn(`[patch-chat21-node-sdk-auth] missing ${patch.file}; skipping`);
    continue;
  }

  let content = fs.readFileSync(patch.file, 'utf8');
  const before = content;

  for (const [from, to] of patch.replacements) {
    content = content.split(from).join(to);
  }

  if (content !== before) {
    fs.writeFileSync(patch.file, content);
    console.log(`[patch-chat21-node-sdk-auth] patched ${patch.file}`);
  } else {
    console.log(`[patch-chat21-node-sdk-auth] no change ${patch.file}`);
  }
}
