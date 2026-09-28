using System;

class Program
{
    static void Main()
    {
        string text = Console.ReadLine();
        int n = int.Parse(Console.ReadLine());
        
        for (int i = 0; i < n; i++)
        {
            Console.WriteLine(text);
        }
    }
}