#!/usr/bin/env python3
"""
FSC 集群自动部署脚本
自动在多台服务器上部署 FSC + OpenClaw + WireGuard
"""

import os
import sys
import json
import subprocess
import argparse
import uuid
from pathlib import Path
from typing import List, Dict

NODES = [
    {"name": "node1", "ip": "<NODE1_IP>", "role": "coordinator", "ssh_key": "~/.ssh/id_rsa"},
    {"name": "node2", "ip": "<NODE2_IP>", "role": "executor-claude", "ssh_key": "~/.ssh/id_rsa"},
    {"name": "node3", "ip": "<NODE3_IP>", "role": "executor-gemini", "ssh_key": "~/.ssh/id_rsa"},
]

INSTALL_SCRIPT = """#!/bin/bash
set -e

echo "=== 安装 FSC 依赖 ==="

# 安装 Bun
if ! command -v bun &> /dev/null; then
    curl -fsSL https://bun.sh/install | bash
    echo 'registry = "https://registry.npmjs.org/"' > ~/.bunfig.toml
fi

# 安装 Docker
if ! command -v docker &> /dev/null; then
    if command -v dnf &> /dev/null; then
        dnf install -y podman-docker
    elif command -v apt-get &> /dev/null; then
        apt-get update && apt-get install -y docker.io
    fi
fi

# 安装 WireGuard
if ! command -v wg &> /dev/null; then
    if command -v dnf &> /dev/null; then
        dnf install -y wireguard-tools
    elif command -v apt-get &> /dev/null; then
        apt-get update && apt-get install -y wireguard
    fi
fi

echo "=== 安装完成 ==="
bun --version
docker --version
wg --version
"""

class ClusterDeployer:
    def __init__(self, nodes: List[Dict]):
        self.nodes = nodes
        self.session_id = str(uuid.uuid4())[:8]
        
    def log(self, msg: str):
        print(f"[{self.session_id}] {msg}")
        
    def run_ssh(self, node: Dict, cmd: str) -> tuple:
        """在远程节点执行命令"""
        ssh_key = os.path.expanduser(node["ssh_key"])
        full_cmd = f"ssh -i {ssh_key} -o StrictHostKeyChecking=no root@{node['ip']} \"{cmd}\""
        result = subprocess.run(
            full_cmd, shell=True, capture_output=True, text=True
        )
        return result.returncode, result.stdout, result.stderr
    
    def check_node(self, node: Dict) -> bool:
        """检查节点连通性"""
        self.log(f"检查节点 {node['name']} ({node['ip']})...")
        code, stdout, stderr = self.run_ssh(node, "echo ok")
        if code == 0:
            self.log(f"  ✅ {node['name']} 可达")
            return True
        else:
            self.log(f"  ❌ {node['name']} 不可达: {stderr}")
            return False
    
    def install_dependencies(self, node: Dict) -> bool:
        """在节点安装依赖"""
        self.log(f"在 {node['name']} 安装依赖...")
        
        # 复制安装脚本
        script_path = f"/tmp/fsc_install_{node['name']}.sh"
        with open(script_path, "w") as f:
            f.write(INSTALL_SCRIPT)
        
        # 上传并执行
        ssh_key = os.path.expanduser(node["ssh_key"])
        subprocess.run(
            f"scp -i {ssh_key} {script_path} root@{node['ip']}:/tmp/fsc_install.sh",
            shell=True, check=True
        )
        
        code, stdout, stderr = self.run_ssh(node, "bash /tmp/fsc_install.sh")
        if code == 0:
            self.log(f"  ✅ {node['name']} 依赖安装完成")
            return True
        else:
            self.log(f"  ❌ {node['name']} 安装失败: {stderr}")
            return False
    
    def setup_wireguard(self, node: Dict, wg_config: str) -> bool:
        """配置 WireGuard"""
        self.log(f"配置 {node['name']} WireGuard...")
        
        config_path = "/tmp/wg0.conf"
        with open(config_path, "w") as f:
            f.write(wg_config)
        
        ssh_key = os.path.expanduser(node["ssh_key"])
        subprocess.run(
            f"scp -i {ssh_key} {config_path} root@{node['ip']}:/etc/wireguard/wg0.conf",
            shell=True, check=True
        )
        
        code, stdout, stderr = self.run_ssh(node, "wg-quick up wg0 && systemctl enable wg-quick@wg0")
        if code == 0:
            self.log(f"  ✅ {node['name']} WireGuard 配置完成")
            return True
        else:
            self.log(f"  ⚠️ {node['name']} WireGuard: {stderr}")
            return False
    
    def deploy(self, wg_configs: Dict[str, str] = None):
        """执行集群部署"""
        self.log("=" * 50)
        self.log("FSC 集群自动部署开始")
        self.log("=" * 50)
        
        # 1. 检查所有节点
        self.log("\n[1/4] 检查节点连通性...")
        reachable = [n for n in self.nodes if self.check_node(n)]
        if len(reachable) < len(self.nodes):
            self.log("部分节点不可达，部署终止")
            return False
        
        # 2. 安装依赖
        self.log("\n[2/4] 安装依赖...")
        for node in self.nodes:
            if not self.install_dependencies(node):
                self.log(f"节点 {node['name']} 依赖安装失败")
                return False
        
        # 3. 配置 WireGuard
        if wg_configs:
            self.log("\n[3/4] 配置 WireGuard...")
            for node in self.nodes:
                if node["name"] in wg_configs:
                    self.setup_wireguard(node, wg_configs[node["name"]])
        
        # 4. 验证部署
        self.log("\n[4/4] 验证部署...")
        for node in self.nodes:
            code, stdout, _ = self.run_ssh(node, "bun --version && docker --version")
            if code == 0:
                self.log(f"  ✅ {node['name']} 验证通过")
        
        self.log("\n" + "=" * 50)
        self.log("✅ 集群部署完成!")
        self.log("=" * 50)
        return True

def main():
    parser = argparse.ArgumentParser(description="FSC 集群自动部署")
    parser.add_argument("--nodes", "-n", type=int, default=3, help="节点数量")
    parser.add_argument("--check-only", action="store_true", help="仅检查连通性")
    parser.add_argument("--skip-wireguard", action="store_true", help="跳过 WireGuard 配置")
    
    args = parser.parse_args()
    
    # 加载节点配置
    nodes_file = Path(__file__).parent / "cluster_config.json"
    if nodes_file.exists():
        with open(nodes_file) as f:
            nodes = json.load(f)
    else:
        nodes = NODES
    
    deployer = ClusterDeployer(nodes)
    
    if args.check_only:
        for node in nodes:
            deployer.check_node(node)
    else:
        deployer.deploy()

if __name__ == "__main__":
    main()
