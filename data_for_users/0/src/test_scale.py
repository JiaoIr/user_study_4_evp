class ViewPort:

    def __init__(self, x1, y1, x2, y2):
        self.x1 = x1
        self.y1 = y1
        self.x2 = x2
        self.y2 = y2

    def get_width(self):
        return self.x2 - self.x1

    def get_height(self):
        return self.y2 - self.y1

    def get_center_x(self):
        return (self.x1 + self.x2) / 2

    def get_center_y(self):
        return (self.y1 + self.y2) / 2

class Chart:

    def __init__(self):
        self.viewport = None

    def set_viewport(self, x1, y1, x2, y2):
        self.viewport = ViewPort(x1, y1, x2, y2)

    def get_viewport(self):
        return self.viewport

    def scale(self, factor):

        width = self.viewport.get_width()
        height = self.viewport.get_height()

        new_width = width * factor
        new_height = height * factor

        center_x = self.viewport.get_center_x()
        center_y = self.viewport.get_center_y()

        offset_x = new_width / 2
        offset_y = new_height / 2

        x1 = center_x - offset_x
        y1 = center_y - offset_y
        x2 = center_y + offset_x
        y2 = center_y + offset_y

        self.viewport = ViewPort(x1, y1, x2, y2)

def test_scale():

    chart = Chart()

    # initial viewport
    chart.set_viewport(0, 0, 200, 100)

    # scale
    chart.scale(2.0)

    vp = chart.get_viewport()

    # center should stay
    assert abs(vp.get_center_x() - 100) < 0.01
    assert abs(vp.get_center_y() - 50) < 0.01


if __name__ == "__main__":
    test_scale()