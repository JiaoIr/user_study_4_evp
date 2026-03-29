def detect_collision(poly_a, poly_b):
    debug = []

    # -------------------------
    # Step 1: compute AABB
    # -------------------------
    def compute_aabb(poly):
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        return [min(xs), max(xs), min(ys), max(ys)]

    box_a = compute_aabb(poly_a)
    box_b = compute_aabb(poly_b)

    # -------------------------
    # Step 2: compute directional padding
    # -------------------------
    def compute_padding(poly):
        min_x, max_x, min_y, max_y = compute_aabb(poly)
        width = max_x - min_x
        height = max_y - min_y

        base = 0.5

        if width > height:
            return (base * 2, base)
        else:
            return (base, base * 2)

    pad_a = compute_padding(poly_a)
    pad_b = compute_padding(poly_b)

    # -------------------------
    # Step 3: apply padding
    # -------------------------
    def pad_box(box, padding):
        min_x, max_x, min_y, max_y = box
        pad_x, pad_y = padding
        return [
            min_x - pad_x,
            max_x + pad_x,
            min_y - pad_y,
            max_y + pad_y
        ]

    padded_a = pad_box(box_a, pad_a)
    padded_b = pad_box(box_b, pad_b)

    debug.append(("boxes", box_a, box_b))
    debug.append(("padding", pad_a, pad_b))
    debug.append(("padded", padded_a, padded_b))

    # -------------------------
    # Step 4: overlap check
    # -------------------------
    def overlap(b1, b2):
        min_x1, max_x1, min_y1, max_y1 = b1
        min_x2, max_x2, min_y2, max_y2 = b2

        x_overlap = not (max_x1 < min_x2 or max_x2 < min_x1)
        y_overlap = not (max_y1 < min_y2 or max_y2 < min_y1)

        return x_overlap and y_overlap

    return overlap(padded_a, padded_b)


# -------------------------
# Test
# -------------------------
def test_collision():
    poly_a = [(0, 0), (2, 0), (2, 4), (0, 4)]
    poly_b = [(2.6, 1), (6.6, 1), (6.6, 2), (2.6, 2)]

    result = detect_collision(poly_a, poly_b)

    expected = False

    print("Result:", result)
    assert result == expected, f"{result} != {expected}"


if __name__ == "__main__":
    test_collision()