using Microsoft.Maui.Controls;

namespace TmLab;

public partial class App : Application
{
    public App()
    {
        InitializeComponent();
    }

    protected override Window CreateWindow(IActivationState? activationState) =>
        new Window(new AppShell()) { Title = "Транзакционная память" };
}
