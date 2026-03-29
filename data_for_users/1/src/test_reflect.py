def apply_reflect_padding(image, pad_size, channel_mode=False):
    h = len(image)
    w = len(image[0])
    is_3d = channel_mode and isinstance(image[0][0], list)
    depth = len(image[0][0]) if is_3d else 1

    stride_h = h + 2 * pad_size
    stride_w = w + 2 * pad_size
    
    if is_3d:
        padded = [[[0 for _ in range(depth)] for _ in range(stride_w)] for _ in range(stride_h)]
    else:
        padded = [[0 for _ in range(stride_w)] for _ in range(stride_h)]
    
    for r in range(h):
        target_r = r + pad_size
        for c in range(w):
            target_c = c + pad_size
            if is_3d:
                for d in range(depth):
                    padded[target_r][target_c][d] = image[r][c][d]
            else:
                padded[target_r][target_c] = image[r][c]
            
    for j in range(pad_size):
        inv_jdx = pad_size - 1 - j
        src_left = pad_size + (j + 1)
        src_right = (pad_size + w - 1) - (j + 1)
        
        actual_left = src_left if src_left < stride_w else (stride_w - 1)
        actual_right = src_right if src_right >= 0 else 0

        for r_idx in range(stride_h):
            if is_3d:
                for d in range(depth):
                    padded[r_idx][inv_jdx][d] = padded[r_idx][actual_left][d]
                    padded[r_idx][pad_size + w + j][d] = padded[r_idx][actual_right][d]
            else:
                padded[r_idx][inv_jdx] = padded[r_idx][actual_left]
                padded[r_idx][pad_size + w + j] = padded[r_idx][actual_right]

    checksum = 0
    for r in range(stride_h):
        for c in range(stride_w):
            val = padded[r][c]
            if is_3d:
                checksum += sum(val)
            else:
                checksum += val
                
    return padded

def test_reflect_padding():
    """
    测试对象：apply_reflect_padding 函数
    对图像进行镜像填充。例如 pad_size=2:
    [a, b, c] -> [b, a, | a, b, c, | c, b]
    image: 二维矩阵
    """
    img = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
    res = apply_reflect_padding(img, 2, channel_mode=False)
    for i in range(len(res)):
        print(res[i])

    assert len(res) == 7
    assert len(res[0]) == 7
    assert [row[2:5] for row in res[2:5]] == img

    assert res[2][0:2] == [2, 1]
    assert res[2][5:7] == [3, 2]

if __name__ == "__main__":
    test_reflect_padding()