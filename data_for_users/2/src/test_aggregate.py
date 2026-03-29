def aggregate_sensor_layers(layers, window_size, step):
    """
    layers: list of list (e.g., [Layer0, Layer1])

    We simulate real-world asynchronous sensors:
    - Each layer may have a small phase shift
    - Then signals are fused assuming aligned time steps
    """

    num_layers = len(layers)
    output_signal = []
    layer_results = []

    # Step 0: compute per-layer offsets (simulating phase shift)
    offsets = []
    for i in range(num_layers):
        offsets.append(i % 2)

    debug_history = []

    for i in range(num_layers):
        data = layers[i]
        res = []

        for start in range(0, len(data) - window_size + 1, step):
            effective_start = start + offsets[i]

            debug_history.append((i, start, effective_start))

            if effective_start + window_size > len(data):
                break

            window = data[effective_start : effective_start + window_size]
            res.append(sum(window) / len(window))

        layer_results.append(res)

    # Step 2: aggregate across layers
    min_len = min(len(r) for r in layer_results)

    for idx in range(min_len):
        combined = 0
        for layer_idx in range(num_layers):
            shifted_idx = idx + layer_idx

            if shifted_idx >= len(layer_results[layer_idx]):
                continue

            combined += layer_results[layer_idx][shifted_idx]

        output_signal.append(combined)

    return output_signal


def test_aggregate_sensor_layers():
    s_layers = [
        [10, 20, 30, 40],
        [10, 20, 30, 40]
    ]

    actual = aggregate_sensor_layers(s_layers, 2, 1)

    expected = [30.0, 50.0, 70.0]

    assert actual == expected, f"Assertion failed: expected {expected}, got {actual}"


if __name__ == "__main__":
    test_aggregate_sensor_layers()