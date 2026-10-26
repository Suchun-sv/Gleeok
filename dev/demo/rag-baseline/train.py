"""A toy run for the README demo's 做实验 scene: a small MLP on synthetic data, pure Python, under a second."""
import argparse
import math
import random
import time

p = argparse.ArgumentParser()
p.add_argument('--epochs', type=int, default=8)
p.add_argument('--lr', type=float, default=0.1)
p.add_argument('--hidden', type=int, default=16)
args = p.parse_args()
random.seed(0)


def sample(n):
    # Two interleaved spirals: not linearly separable, so the hidden layer has work to do.
    out = []
    for i in range(n):
        y = i % 2
        t = random.uniform(0.3, 3.0)
        a = t * 2.2 + math.pi * y
        out.append(([t * math.cos(a) / 3 + random.gauss(0, 0.04), t * math.sin(a) / 3 + random.gauss(0, 0.04)], y))
    return out


train, dev = sample(600), sample(200)
H = args.hidden
W1 = [[random.gauss(0, 1) for _ in range(2)] for _ in range(H)]
b1 = [0.0] * H
W2 = [random.gauss(0, 0.3) for _ in range(H)]
b2 = 0.0


def forward(x):
    h = [math.tanh(W1[j][0] * x[0] + W1[j][1] * x[1] + b1[j]) for j in range(H)]
    z = sum(W2[j] * h[j] for j in range(H)) + b2
    return h, 1 / (1 + math.exp(-max(-30, min(30, z))))


def accuracy(data):
    return sum((forward(x)[1] > 0.5) == y for x, y in data) / len(data)


G, C, D, R = '\033[32m', '\033[36m', '\033[2m', '\033[0m'
print(f'{D}config{R}  model=mlp-{H}  lr={args.lr}  epochs={args.epochs}  train={len(train)}  dev={len(dev)}')
start, best = time.time(), 0.0
for epoch in range(1, args.epochs + 1):
    random.shuffle(train)
    total = 0.0
    for x, y in train:
        h, out = forward(x)
        total += -math.log(max(out if y else 1 - out, 1e-12))
        g = out - y
        for j in range(H):
            gh = g * W2[j] * (1 - h[j] ** 2)
            W2[j] -= args.lr * g * h[j]
            W1[j][0] -= args.lr * gh * x[0]
            W1[j][1] -= args.lr * gh * x[1]
            b1[j] -= args.lr * gh
        b2 -= args.lr * g
    acc = accuracy(dev)
    best = max(best, acc)
    bar = '█' * epoch + '░' * (args.epochs - epoch)
    print(f'epoch {epoch:>2}/{args.epochs}  {C}{bar}{R}  loss {total / len(train):.4f}  dev acc {G if acc == best else ""}{acc:.3f}{R}')
print(f'{G}✓{R} done in {time.time() - start:.1f}s · best dev acc {best:.3f}')
